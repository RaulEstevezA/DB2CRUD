"""The Prisma repositories, over a client (the application's or a transaction's): rows become the project's plain
entities and back, with the conversions Prisma's types need (whole numbers of 64 bits, decimals, dates and times,
bytes, JSON and enum values); reads leave out rows marked as deleted; pages go by offset or after a key; and a database
refusal becomes a ConflictError. Mirrors web/src/core/generators/typescript/prisma/repository.ts."""

import json

from ..common.context import column_type, is_in, query
from ..typescript import TsImports
from .schema import enum_name, field_of, member_of, native_enum, renames_values


def client_module(context: dict) -> str:
    """The module the Prisma client and its types are imported from: the generated one, or the project's own."""
    if any(info["writesEntity"] for info in context["tables"]):
        return "src/generated/prisma/client"
    return context["settings"]["entitiesModule"].replace(".", "/")


def accessor(info: dict) -> str:
    """orderLine: the property of the client for a model."""
    return info["entity"][:1].lower() + info["entity"][1:]


def _row_type(info: dict) -> str:
    return f"Prisma.{info['entity']}Model"


def _values_record(context: dict, column: dict) -> str:
    """Name of the record that turns the Prisma names of an enum's values into the values."""
    return f"{enum_name(native_enum(context, column['column']['type'])).upper()}_VALUES"


def _names_record(context: dict, column: dict) -> str:
    return f"{enum_name(native_enum(context, column['column']['type'])).upper()}_NAMES"


def _from_row(context: dict, column: dict, value: str) -> str | None:
    """A value of a Prisma row as the entity keeps it, when it needs converting."""
    kind_of = column["column"]["type"]
    prisma = field_of(context, kind_of)["type"]
    kind = kind_of["kind"]
    if kind == "integer":
        return f"Number({value})" if prisma == "BigInt" else None
    if kind == "decimal":
        scale = kind_of.get("scale")
        return f"{value}.toFixed({scale})" if scale is not None else f"{value}.toFixed()"
    if kind == "date":
        return f"{value}.toISOString().slice(0, 10)"
    if kind == "time":
        return f"{value}.toISOString().slice(11, 19)" if prisma == "DateTime" else None
    if kind == "binary":
        return f"Buffer.from({value})"
    if kind == "array":
        return f"{value} as {column_type(column)}"
    if kind == "enum":
        item = native_enum(context, kind_of)
        return f"{_values_record(context, column)}[{value}]" if item and renames_values(item) else None
    return None


def _to_prisma(context: dict, column: dict, value: str, imports: TsImports) -> str | None:
    """A value of the entity as Prisma writes it, when it needs converting."""
    kind_of = column["column"]["type"]
    prisma = field_of(context, kind_of)["type"]
    kind = kind_of["kind"]
    if kind == "date":
        return f"new Date({value})"
    if kind == "time":
        return f"new Date(`1970-01-01T${{{value}}}Z`)" if prisma == "DateTime" else None
    if kind == "binary":
        return f"new Uint8Array({value})"
    if kind == "enum":
        item = native_enum(context, kind_of)
        if not item:
            return None
        if renames_values(item):
            return f"{_names_record(context, column)}[{value}]"
        imports.type(client_module(context), "$Enums")
        return f"{value} as $Enums.{enum_name(item)}"
    return None


def _is_json(column: dict) -> bool:
    return column["column"]["type"]["kind"] in ("json", "array")


def _read_property(context: dict, column: dict) -> str:
    """name: value of a property read from a row."""
    value = f"row.{column['prop']}"
    converted = _from_row(context, column, value)
    if not converted:
        return f"{column['prop']}: {value}"
    nullable = column["column"]["nullable"] and not _is_json(column)
    return f"{column['prop']}: {f'{value} === null ? null : {converted}' if nullable else converted}"


def _write_property(context: dict, column: dict, imports: TsImports) -> str:
    """name: value of a property written from the entity; undefined values are left for the database to fill."""
    prop = column["prop"]
    value = f"entity.{prop}"
    if _is_json(column):
        imports.from_(client_module(context), "Prisma")
        if column["column"]["nullable"]:
            return f"{prop}: {value} === null ? Prisma.DbNull : ({value} as Prisma.InputJsonValue)"
        return f"{prop}: {value} as Prisma.InputJsonValue"
    converted = _to_prisma(context, column, value, imports)
    return f"{prop}: {value} == null ? {value} : {converted}" if converted else f"{prop}: {value}"


def _condition(context: dict, column: dict, value: str, imports: TsImports) -> str:
    """A condition on a column, with the value converted as Prisma compares it."""
    converted = None if _is_json(column) else _to_prisma(context, column, value, imports)
    if converted:
        return f"{column['prop']}: {converted}"
    return column["prop"] if value == column["prop"] else f"{column['prop']}: {value}"


def _writable(column: dict) -> bool:
    """A computed column is never written."""
    return not isinstance(column["column"].get("generated"), dict)


def _changeable(info: dict, column: dict) -> bool:
    """Nor the key of a stored row, nor what the database fills."""
    return _writable(column) and not is_in(column, info["key"]) and not column["generated"]


def _multiline(opening: str, items: list[str], closing: str) -> list:
    return [opening, *(f"    {item}," for item in items), closing]


def prisma_helpers(context: dict, info: dict, imports: TsImports) -> list:
    """toEntity, createData and updateData of a table, and the records of renamed enum values."""
    imports.from_(client_module(context), "Prisma")
    result: list = []
    enums: dict[str, dict] = {}
    for column in info["columns"]:
        item = native_enum(context, column["column"]["type"])
        if item and renames_values(item):
            enums[item["name"]] = column
    for column in enums.values():
        item = native_enum(context, column["column"]["type"])
        imports.type(client_module(context), "$Enums")
        pairs = ", ".join(
            f"{member_of(value)}: {json.dumps(value, ensure_ascii=False).replace(chr(34), chr(39))}"
            for value in item["values"]
        )
        values = _values_record(context, column)
        result += [
            f"/** The values of {item['name']} by their Prisma names, and back: the client uses the names. */",
            f"const {values}: Record<$Enums.{enum_name(item)}, string> = {{ {pairs} }}",
            f"const {_names_record(context, column)} = Object.fromEntries(Object.entries({values}).map(([name, value]) => [value, name])) as Record<string, $Enums.{enum_name(item)}>",
            "",
        ]
    entity = info["entity"]
    result += [
        f"/** The {entity} of a row Prisma read. */",
        f"function toEntity(row: {_row_type(info)}): {entity} {{",
        *_multiline(
            f"  return Object.assign(new {entity}(), {{",
            [_read_property(context, column) for column in info["columns"]],
            "  })",
        ),
        "}",
    ]
    if query(info, "insert"):
        result += [
            "",
            "/** The values of a new row; those left undefined take the database's default. */",
            f"function createData(entity: {entity}): Prisma.{entity}UncheckedCreateInput {{",
            *_multiline(
                "  return {",
                [_write_property(context, column, imports) for column in info["columns"] if _writable(column)],
                "  }",
            ),
            "}",
        ]
    if query(info, "update"):
        columns = [column for column in info["columns"] if _changeable(info, column)]
        result += [
            "",
            "/** The values a change writes: not the key, nor what the database fills. */",
            f"function updateData(entity: {entity}): Prisma.{entity}UncheckedUpdateManyInput {{",
            *(
                _multiline("  return {", [_write_property(context, column, imports) for column in columns], "  }")
                if columns
                else ["  return {}"]
            ),
            "}",
        ]
    return result


# Bodies


def _soft_condition(info: dict) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    soft = info["soft"]
    if not soft:
        return None
    return f"{soft['prop']}: {'false' if soft['column']['type']['kind'] == 'boolean' else 'null'}"


def _where_of(conditions: list) -> str | None:
    present = [item for item in conditions if item is not None]
    return f"where: {{ {', '.join(present)} }}" if present else None


def _order_by(info: dict) -> str:
    if len(info["key"]) == 1:
        return f"orderBy: {{ {info['key'][0]['prop']}: 'asc' }}"
    columns = ", ".join("{ " + column["prop"] + ": 'asc' }" for column in info["key"])
    return f"orderBy: [{columns}]"


def _args(items: list) -> str:
    present = [item for item in items if item is not None]
    return f"{{ {', '.join(present)} }}" if present else ""


def _write(context: dict, info: dict, action: list[str], imports: TsImports) -> list:
    """A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError."""
    imports.from_(client_module(context), "Prisma").from_("src/errors", "ConflictError")
    return [
        "try {",
        *(f"  {line}" for line in action),
        "} catch (error) {",
        f"  if (error instanceof Prisma.PrismaClientKnownRequestError) throw new ConflictError('{info['entity']}', `the database refused the change: ${{error.message}}`)",
        "  throw error",
        "}",
    ]


def _key_where(context: dict, info: dict, imports: TsImports) -> str:
    conditions = ", ".join(_condition(context, column, f"entity.{column['prop']}", imports) for column in info["key"])
    return f"where: {{ {conditions} }}"


def prisma_body(context: dict, info: dict, method: dict, imports: TsImports) -> list:
    model = f"this.db.{accessor(info)}"
    # The parameters of a read by columns are named after them
    by_params = []
    for name in method["query"]["columns"]:
        column = next(item for item in info["columns"] if item["column"]["name"] == name)
        by_params.append(_condition(context, column, column["prop"], imports))
    kind = method["query"]["kind"]
    soft = _soft_condition(info)
    if kind in ("getByKey", "findByUnique"):
        return [
            f"const row = await {model}.findFirst({_args([_where_of([*by_params, soft])])})",
            "return row === null ? null : toEntity(row)",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [
            f"return (await {model}.findMany({_args([_where_of([*by_params, soft]), _order_by(info)])})).map(toEntity)"
        ]
    if kind == "list":
        where = _where_of([soft])
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"const rows = await {model}.findMany({_args([where, _order_by(info), 'skip: offset', 'take: limit'])})",
                f"const total = await {model}.count({_args([where])})",
                "return { items: rows.map(toEntity), total, offset, limit }",
            ]
        if paging == "cursor":
            imports.from_(client_module(context), "Prisma")
            key = info["key"]

            # After the key (a, b): a greater, or a the same and b greater
            def value(index: int) -> str:
                column = key[index]
                raw = f"after[{index}] as {column['ts']}"
                if _is_json(column):
                    return raw
                return _to_prisma(context, column, f"({raw})", imports) or raw

            after = [
                ", ".join(
                    [
                        *(f"{before['prop']}: {value(position)}" for position, before in enumerate(key[:index])),
                        f"{column['prop']}: {{ gt: {value(index)} }}",
                    ]
                )
                for index, column in enumerate(key)
            ]
            initial = f"{{ {soft} }}" if soft else "{}"
            if len(key) == 1:
                condition = f"if (after !== null) where.{key[0]['prop']} = {{ gt: {value(0)} }}"
            else:
                condition = f"if (after !== null) where.OR = [{', '.join(f'{{ {item} }}' for item in after)}]"
            last = ", ".join(f"last.{column['prop']}" for column in key)
            return [
                f"const where: Prisma.{info['entity']}WhereInput = {initial}",
                condition,
                f"const rows = (await {model}.findMany({{ where, {_order_by(info)}, take: limit + 1 }})).map(toEntity)",
                "const items = rows.slice(0, limit)",
                "const last = items[items.length - 1]",
                f"return {{ items, next: rows.length > limit ? [{last}] : null }}",
            ]
        return [f"return (await {model}.findMany({_args([where, _order_by(info)])})).map(toEntity)"]
    if kind == "insert":
        # The values the database filled (the key, defaults) are read back into the entity
        return _write(
            context,
            info,
            [f"return Object.assign(entity, toEntity(await {model}.create({{ data: createData(entity) }})))"],
            imports,
        )
    if kind == "update":
        action = f"await {model}.updateMany({{ {_key_where(context, info, imports)}, data: updateData(entity) }})"
        return [*_write(context, info, [action], imports), "return entity"]
    if kind == "delete":
        return _write(context, info, [f"await {model}.deleteMany({{ {_key_where(context, info, imports)} }})"], imports)
    return ["throw new Error('not written')"]
