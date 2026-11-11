"""TypeORM storage of the NestJS project: one entity per resource, with column types that work the same on
PostgreSQL, MySQL and MariaDB (dates as ISO text, embedded objects and lists as JSON text, exact numbers read back
as numbers), and a repository that implements the resource's storage interface with it. Mirrors
web/src/core/generators/frameworks/nestjs/typeorm.ts.
"""

from ....js import number_text
from ...common.text import file_text, lines
from ...languages.typescript.typescript import TsImports, ts_access, ts_doc, ts_property, ts_string
from .context import NestContext, import_path, key_field, key_type, names, resource_path
from .dto import ts_type_of


def _column(context: NestContext, resource: dict, field: dict, imports: TsImports) -> str:
    """The column options of a field."""
    is_key = field["name"] == resource["key"]["field"]
    generated = resource["key"]["generated"]
    if is_key and generated == "increment":
        imports.add("typeorm", "PrimaryGeneratedColumn")
        return "@PrimaryGeneratedColumn()"
    if is_key and generated == "uuid":
        imports.add("typeorm", "PrimaryGeneratedColumn")
        return "@PrimaryGeneratedColumn('uuid')"
    options: list[str] = []
    type_ref = field["type"]
    kind = type_ref["kind"]
    if field.get("reference") and kind != "array":
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        scalar = target["key"]["type"]["scalar"]
    else:
        scalar = type_ref["scalar"] if kind == "scalar" else None
    columns = import_path(resource_path(resource, "entity"), "src/common/columns.ts")
    if kind in ("object", "array", "map") or scalar == "any":
        options.append("type: 'simple-json'")
    elif kind == "enum":
        options.extend(["type: 'varchar'", "length: 64"])
    elif scalar == "integer":
        if kind == "scalar" and type_ref.get("bits") == 64:
            imports.add(columns, "numeric")
            options.extend(["type: 'bigint'", "transformer: numeric"])
        else:
            options.append("type: 'int'")
    elif scalar == "float":
        options.append("type: 'double precision'")
    elif scalar == "decimal":
        imports.add(columns, "numeric")
        # Read back as a number, as the API sends it
        options.extend(["type: 'decimal'", "precision: 18", "scale: 4", "transformer: numeric"])
    elif scalar == "boolean":
        options.append("type: 'boolean'")
    elif scalar == "uuid":
        options.extend(["type: 'varchar'", "length: 36"])
    elif scalar in ("date", "datetime", "time", "duration"):
        # ISO text: the same on every database
        options.extend(["type: 'varchar'", "length: 40"])
    elif field["constraints"].get("maxLength") is not None or is_key or field.get("reference"):
        maximum = field["constraints"].get("maxLength")
        options.extend(["type: 'varchar'", f"length: {number_text(maximum) if maximum is not None else 255}"])
    else:
        options.append("type: 'text'")
    if not is_key and (field["nullable"] or not field["required"] or field.get("server") == "pending"):
        options.append("nullable: true")
    if is_key:
        imports.add("typeorm", "PrimaryColumn")
        return f"@PrimaryColumn({{ {', '.join(options)} }})"
    imports.add("typeorm", "Column")
    return f"@Column({{ {', '.join(options)} }})"


def entity_file(context: NestContext, resource: dict) -> dict | None:
    if not context.typeorm:
        return None
    path = resource_path(resource, "entity")
    name = names(resource)
    imports = TsImports().add("typeorm", "Entity")
    fields = []
    for field in resource["fields"]:
        decorator = _column(context, resource, field, imports)
        type_ref = field["type"]
        if field.get("reference"):
            target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
            type_text = f"{key_type(target)}[]" if type_ref["kind"] == "array" else key_type(target)
        else:
            type_text = ts_type_of(type_ref)
        inner = type_ref["items"] if type_ref["kind"] == "array" else type_ref
        if inner["kind"] in ("object", "enum"):
            imports.add_type(import_path(path, "src/shared/shared.dto.ts"), ts_type_of(inner))
        nullable = " | null" if field["nullable"] or not field["required"] else ""
        fields.append(f"  {decorator}\n  {ts_property(field['wire'])}!: {type_text}{nullable}")
    content = lines(
        ts_doc(
            f"Table of {resource['plural']}. Dates are ISO text and embedded objects and lists JSON text, the same on every database."
        ),
        "",
        imports.render(),
        "",
        f"@Entity({{ name: {ts_string(resource['plural'].replace(' ', '_'))} }})",
        f"export class {name['entity']} {{",
        "\n\n".join(fields),
        "}",
    )
    return {"path": path, "content": file_text(content)}


def typeorm_repository_block(resource: dict, imports: TsImports, path: str) -> str:
    """The repository class that keeps a resource with TypeORM."""
    name = names(resource)
    entity = name["entity"]
    record = name["record"]
    key = key_type(resource)
    key_wire = key_field(resource)["wire"]
    key_property = ts_property(key_wire)
    imports.add("@nestjs/typeorm", "InjectRepository")
    imports.add("@nestjs/common", "Injectable")
    imports.add("typeorm", "Repository")
    imports.add_type("typeorm", "DeepPartial")
    imports.add(import_path(path, resource_path(resource, "entity")), entity)
    new_type = f"Omit<{record}, {ts_string(key_wire)}>" if resource["key"]["generated"] else record
    return lines(
        "/** A stored row as a record: empty columns become absent fields, as the API shows optional fields. */",
        f"function toRecord(row: {entity}): {record} {{",
        f"  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as {record}",
        "}",
        "",
        f"/** Keeps {resource['plural']} in the database with TypeORM. */",
        "@Injectable()",
        f"export class {name['typeormRepository']} implements {name['repository']} {{",
        f"  constructor(@InjectRepository({entity}) private readonly data: Repository<{entity}>) {{}}",
        "",
        f"  async list(query: ListQuery): Promise<ListResult<{record}>> {{",
        f"    const order = query.sort ? {{ [query.sort.field]: query.sort.descending ? 'DESC' : 'ASC', {key_property}: 'ASC' }} : {{ {key_property}: 'ASC' }}",
        "    const [rows, total] = await this.data.findAndCount({",
        "      where: query.filters as never,",
        "      order: order as never,",
        "      skip: query.offset,",
        "      take: query.limit,",
        "    })",
        "    return { items: rows.map(toRecord), total }",
        "  }",
        "",
        f"  async get(key: {key}): Promise<{record} | undefined> {{",
        f"    const row = await this.data.findOneBy({{ {key_property}: key }} as never)",
        "    return row ? toRecord(row) : undefined",
        "  }",
        "",
        f"  async add(values: {new_type}): Promise<{record}> {{",
        f"    const row = await this.data.save(this.data.create(values as DeepPartial<{entity}>))",
        f"    return (await this.get({ts_access('row', key_wire)} as {key}))!",
        "  }",
        "",
        f"  async update(key: {key}, values: Partial<{record}>): Promise<{record}> {{",
        f"    const row = await this.data.findOneByOrFail({{ {key_property}: key }} as never)",
        f"    await this.data.save(this.data.merge(row, values as DeepPartial<{entity}>))",
        "    return (await this.get(key))!",
        "  }",
        "",
        f"  async delete(key: {key}): Promise<void> {{",
        f"    await this.data.delete({{ {key_property}: key }} as never)",
        "  }",
        "}",
    )
