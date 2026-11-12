"""The JPA entity of each table: exact table and column names, the column types of the chosen database, keys (an
@IdClass record when there are several columns), unique constraints, indexes, CHECK constraints and foreign keys (a
read-only many-to-one beside the key columns, so the constraint exists), so the entities reflect the database instead
of designing it. Values the database fills (defaults, identities) are left to it (@DynamicInsert) and read back by
the repositories. Mirrors web/src/core/generators/java/entities.ts."""

import re

from ...js import number_text
from ..types import lines
from .context import find_info, is_in, jpql_name, package_of, qualified
from .java import JavaImports, java_path, java_string

PERSISTENCE = "jakarta.persistence"
HIBERNATE = "org.hibernate.annotations"


def _quote_sql(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _native_enum(context: dict, column: dict) -> dict | None:
    column_type = column["column"]["type"]
    if column_type["kind"] != "enum" or context["settings"]["database"] == "sqlite":
        return None
    item = next((item for item in context["schema"]["enums"] if item["name"] == column_type["name"]), None)
    return item if item is not None and item.get("storage") == "native" else None


def enum_types(context: dict) -> list[str]:
    """The SQL that creates the enum types of PostgreSQL the entities use, for the tests' database."""
    if context["settings"]["database"] != "postgresql":
        return []
    used = set()
    for info in context["tables"]:
        for column in info["columns"]:
            item = _native_enum(context, column)
            if item:
                used.add(item["name"])
    return [
        f'CREATE TYPE "{item["name"]}" AS ENUM ({", ".join(_quote_sql(value) for value in item["values"])})'
        for item in context["schema"]["enums"]
        if item["name"] in used
    ]


def _column_annotations(context: dict, info: dict, column: dict, imports: JavaImports) -> list[str]:
    db = column["column"]
    column_type = db["type"]
    kind = column_type["kind"]
    database = context["settings"]["database"]
    primary_key = info["table"].get("primaryKey")
    single = primary_key is not None and len(primary_key) == 1 and primary_key[0] == db["name"]
    primary = is_in(column, info["key"])
    generated = db.get("generated")
    result = []
    options = [f"name = {java_string(db['name'])}"]
    if not db["nullable"]:
        options.append("nullable = false")
    if kind == "text" and column_type.get("length") is not None:
        options.append(f"length = {column_type['length']}")
    if kind == "binary" and column_type.get("length") is not None:
        options.append(f"length = {column_type['length']}")
    if kind == "decimal" and column_type.get("precision") is not None:
        scale = column_type.get("scale")
        options += [f"precision = {column_type['precision']}", f"scale = {scale if scale is not None else 0}"]
    if kind == "uuid" and database != "postgresql":
        options.append("length = 36")
    enum_type = _native_enum(context, column)
    # MySQL keeps no long text in a key: the key of a table without one stays varchar in the tests' database
    mysql = database in ("mysql", "mariadb")
    if kind == "text" and column_type.get("length") is None and not (mysql and not primary_key):
        options.append('columnDefinition = "text"')
    if enum_type:
        if database == "postgresql":
            definition = f'"{enum_type["name"]}"'
        else:
            definition = f"enum({', '.join(_quote_sql(value) for value in enum_type['values'])})"
        options.append(f"columnDefinition = {java_string(definition)}")
    if isinstance(generated, dict):
        options += ["insertable = false", "updatable = false"]
    if primary:
        imports.add(f"{PERSISTENCE}.Id")
        result.append("@Id")
    if single and generated == "identity":
        imports.add(f"{PERSISTENCE}.GeneratedValue", f"{PERSISTENCE}.GenerationType")
        result.append("@GeneratedValue(strategy = GenerationType.IDENTITY)")
    if single and generated == "uuid":
        imports.add(f"{PERSISTENCE}.GeneratedValue", f"{PERSISTENCE}.GenerationType")
        result.append("@GeneratedValue(strategy = GenerationType.UUID)")
    imports.add(f"{PERSISTENCE}.Column")
    result.append(f"@Column({', '.join(options)})")
    # SQLite counts up a key only when its type is INTEGER
    if single and generated == "identity" and database == "sqlite":
        imports.add(f"{HIBERNATE}.JdbcTypeCode", "org.hibernate.type.SqlTypes")
        result.append("@JdbcTypeCode(SqlTypes.INTEGER)")
    if kind == "text" and column_type.get("fixed"):
        imports.add(f"{HIBERNATE}.JdbcTypeCode", "org.hibernate.type.SqlTypes")
        result.append("@JdbcTypeCode(SqlTypes.CHAR)")
    if kind == "uuid" and database != "postgresql":
        imports.add(f"{HIBERNATE}.JdbcTypeCode", "org.hibernate.type.SqlTypes")
        result.append("@JdbcTypeCode(SqlTypes.CHAR)")
    if kind in ("json", "array"):
        imports.add(f"{HIBERNATE}.JdbcTypeCode", "org.hibernate.type.SqlTypes")
        result.append("@JdbcTypeCode(SqlTypes.JSON)")
    # A uuid that is not the key is made by Hibernate before the insert: SQLite and MySQL have no default for it
    if not single and generated == "uuid":
        imports.add(f"{HIBERNATE}.UuidGenerator")
        result.append("@UuidGenerator")
    if enum_type and database == "postgresql":
        imports.add(f"{HIBERNATE}.ColumnTransformer")
        result.append(f"@ColumnTransformer(write = {java_string('?::' + chr(34) + enum_type['name'] + chr(34))})")
    # What the database fills, for the tests' database; the repositories read it back after an insert
    default = db.get("default")
    if generated in ("now", "onUpdateNow"):
        imports.add(f"{HIBERNATE}.ColumnDefault")
        # MySQL's datetime(6) takes the current time with the same precision
        result.append('@ColumnDefault("CURRENT_TIMESTAMP(6)")' if mysql else '@ColumnDefault("CURRENT_TIMESTAMP")')
    elif generated == "uuid" and not single and database == "postgresql":
        imports.add(f"{HIBERNATE}.ColumnDefault")
        result.append('@ColumnDefault("gen_random_uuid()")')
    elif isinstance(generated, dict):
        imports.add(f"{HIBERNATE}.GeneratedColumn")
        result.append(f"@GeneratedColumn({java_string(generated['computed'])})")
    elif default and default["kind"] == "literal" and default["value"] is not None:
        imports.add(f"{HIBERNATE}.ColumnDefault")
        value = default["value"]
        text = _quote_sql(value) if isinstance(value, str) else number_text(value)
        result.append(f"@ColumnDefault({java_string(text)})")
    elif default and default["kind"] == "expression":
        imports.add(f"{HIBERNATE}.ColumnDefault")
        result.append(f"@ColumnDefault({java_string(default['sql'])})")
    if db.get("comment"):
        imports.add(f"{HIBERNATE}.Comment")
        result.append(f"@Comment({java_string(db['comment'])})")
    return result


ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET_NULL",
    "set default": "SET_DEFAULT",
    "restrict": "RESTRICT",
    "no action": "NO_ACTION",
}


def _relation_name(info: dict, columns: list[str], parent: dict) -> str:
    """The property of the row a foreign key points to: category for category_id."""
    if len(columns) == 1:
        base = re.sub(r"_id$", "", columns[0], flags=re.IGNORECASE)
        base = re.sub(r"_([a-z0-9])", lambda match: match.group(1).upper(), base, flags=re.IGNORECASE)
        base = base[:1].lower() + base[1:]
    else:
        base = parent["attr"]
    taken = any(column["prop"] == base for column in info["columns"])
    return f"{base}Ref" if taken else base


def _relation_lines(context: dict, info: dict, imports: JavaImports) -> list:
    """A read-only many-to-one per foreign key, so the database has the constraint; the key columns stay properties."""
    result: list = []
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if not parent or not parent["table"].get("primaryKey"):
            continue
        if ",".join(parent["table"]["primaryKey"]) != ",".join(key["references"]["columns"]):
            continue
        imports.add(f"{PERSISTENCE}.ManyToOne", f"{PERSISTENCE}.FetchType", f"{PERSISTENCE}.JoinColumn")
        if package_of(context, parent, "entity") != package_of(context, info, "entity"):
            imports.add(qualified(context, parent, "entity", parent["entity"]))
        foreign_key = f", foreignKey = @ForeignKey(name = {java_string(key['name'])})" if key.get("name") else ""
        if key.get("name"):
            imports.add(f"{PERSISTENCE}.ForeignKey")

        def join(name: str, position: int, key: dict = key, foreign_key: str = foreign_key) -> str:
            extra = foreign_key if len(key["columns"]) == 1 else ""
            referenced = java_string(key["references"]["columns"][position])
            return (
                f"@JoinColumn(name = {java_string(name)}, referencedColumnName = {referenced}, "
                f"insertable = false, updatable = false{extra})"
            )

        if len(key["columns"]) == 1:
            joins = [join(key["columns"][0], 0)]
        else:
            imports.add(f"{PERSISTENCE}.JoinColumns")
            inner = ", ".join(join(name, position) for position, name in enumerate(key["columns"]))
            joins = [f"@JoinColumns(value = {{ {inner} }}{foreign_key})"]
        on_delete = key.get("onDelete")
        action = ACTIONS[on_delete] if on_delete and on_delete != "no action" else None
        if action:
            imports.add(f"{HIBERNATE}.OnDelete", f"{HIBERNATE}.OnDeleteAction")
        result += [
            "",
            f"    /** The {parent['entity']} this row points to ({', '.join(key['columns'])}); read only: the key columns are written. */",
            "    @ManyToOne(fetch = FetchType.LAZY)",
            *(f"    {item}" for item in joins),
            action and f"    @OnDelete(action = OnDeleteAction.{action})",
            f"    private {parent['entity']} {_relation_name(info, key['columns'], parent)};",
        ]
    return result


def _class_annotations(info: dict, imports: JavaImports) -> list[str]:
    table = info["table"]
    imports.add(f"{PERSISTENCE}.Entity", f"{PERSISTENCE}.Table", f"{HIBERNATE}.DynamicInsert")

    def names(columns: list[str]) -> str:
        return f"{{ {', '.join(java_string(column) for column in columns)} }}"

    parts = [f"name = {java_string(table['name'])}"]
    if table.get("schema"):
        parts.append(f"schema = {java_string(table['schema'])}")
    if table["uniques"]:
        imports.add(f"{PERSISTENCE}.UniqueConstraint")
        items = ", ".join(
            f"@UniqueConstraint({'name = ' + java_string(unique['name']) + ', ' if unique.get('name') else ''}columnNames = {names(unique['columns'])})"
            for unique in table["uniques"]
        )
        parts.append(f"uniqueConstraints = {{ {items} }}")
    if table["indexes"]:
        imports.add(f"{PERSISTENCE}.Index")
        items = ", ".join(
            f"@Index({'name = ' + java_string(index['name']) + ', ' if index.get('name') else ''}columnList = {java_string(', '.join(index['columns']))})"
            for index in table["indexes"]
        )
        parts.append(f"indexes = {{ {items} }}")
    name = jpql_name(info)
    result = [
        "@Entity" if name == info["entity"] else f"@Entity(name = {java_string(name)})",
        f"@Table({', '.join(parts)})",
        "@DynamicInsert",
    ]
    if len(info["key"]) > 1:
        imports.add(f"{PERSISTENCE}.IdClass")
        result.append(f"@IdClass({info['entity']}.Key.class)")
    for check in table["checks"]:
        imports.add(f"{HIBERNATE}.Check")
        named = f"name = {java_string(check['name'])}, " if check.get("name") else ""
        result.append(f"@Check({named}constraints = {java_string(check['sql'])})")
    return result


def entity_file(context: dict, info: dict) -> dict:
    pkg = package_of(context, info, "entity")
    imports = JavaImports(pkg)
    for column in info["columns"]:
        if column["javaImport"]:
            imports.add(column["javaImport"])
    annotations = _class_annotations(info, imports)
    fields: list = []
    for index, column in enumerate(info["columns"]):
        kind = column["column"]["type"]["kind"]
        sql = column["column"]["type"]["sql"]
        fields += [
            "" if index > 0 else None,
            kind == "unknown" and f'    // TODO: "{sql}" has no JPA type here; it is mapped as text',
            kind == "array" and f'    // TODO: "{sql}" is kept as its JSON text',
            *(f"    {line}" for line in _column_annotations(context, info, column, imports)),
            f"    private {column['java']} {column['prop']};",
        ]
    relations = _relation_lines(context, info, imports)
    if len(info["key"]) > 1:
        imports.add("java.io.Serializable")
    accessors: list = []
    for column in info["columns"]:
        accessors += [
            "",
            f"    public {column['java']} {column['getter']}() {{",
            f"        return {column['prop']};",
            "    }",
            "",
            f"    public void {column['setter']}({column['java']} {column['prop']}) {{",
            f"        this.{column['prop']} = {column['prop']};",
            "    }",
        ]
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    key_fields = ", ".join(f"{column['java']} {column['prop']}" for column in info["key"])
    key_names = ", ".join(column["column"]["name"] for column in info["key"])
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        f'/** A row of the "{info["name"]}" table{comment}. */',
        not info["table"].get("primaryKey")
        and [
            "// The table has no primary key: rows are told apart by all their columns, for reading only, and the",
            "// tests create that key in their own database",
        ],
        *annotations,
        f"public class {info['entity']} {{",
        len(info["key"]) > 1
        and [
            f"    /** The key of a row: {key_names}. */",
            f"    public record Key({key_fields}) implements Serializable {{}}",
            "",
        ],
        *fields,
        *relations,
        *accessors,
        "}",
        "",
    )
    return {"path": java_path(pkg, info["entity"]), "content": content}
