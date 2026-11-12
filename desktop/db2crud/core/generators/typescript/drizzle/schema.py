"""src/schema.ts: a Drizzle table per table that reflects the database instead of designing it (exact table and column
names, the column types of the chosen database, keys, unique values, indexes, CHECK constraints and foreign keys with
their actions, and the enums the database keeps as types), and src/column-types.ts for the types Drizzle lacks (bytes,
and dates SQLite keeps as text). Drizzle never migrates with it: the database already exists; the tests create their
own database from it. Mirrors web/src/core/generators/typescript/drizzle/schema.ts."""

import re

from ....js import number_text
from ...types import lines
from ..common.context import column_of, find_info
from ..typescript import TsImports, member_name, quote

CORE = {
    "postgresql": {"module": "drizzle-orm/pg-core", "table": "pgTable"},
    "mysql": {"module": "drizzle-orm/mysql-core", "table": "mysqlTable"},
    "sqlite": {"module": "drizzle-orm/sqlite-core", "table": "sqliteTable"},
}

# Names the repositories use besides the tables: a table never takes one
TAKEN = {
    "and",
    "asc",
    "count",
    "eq",
    "gt",
    "isNull",
    "or",
    "sql",
    "entity",
    "row",
    "rows",
    "ids",
    "conditions",
    "total",
    "items",
    "last",
    "after",
    "limit",
    "offset",
    "error",
    "schema",
}


def dialect_of(context: dict) -> str:
    database = context["settings"]["database"]
    if database in ("mysql", "mariadb"):
        return "mysql"
    return "sqlite" if database == "sqlite" else "postgresql"


def table_var(info: dict) -> str:
    """The variable of a table in src/schema.ts: orderLines."""
    return f"{info['attr']}Table" if info["attr"] in TAKEN else info["attr"]


def schema_module(context: dict) -> str:
    """The module the tables are imported from: the project's schema, or the one the settings name."""
    if any(info["writesEntity"] for info in context["tables"]):
        return "src/schema"
    return context["settings"]["entitiesModule"].replace(".", "/")


def native_enum(context: dict, column_type: dict) -> dict | None:
    """The enum of a column, when the database keeps it as a type of its own; CHECK enums stay text."""
    if column_type["kind"] != "enum" or dialect_of(context) == "sqlite":
        return None
    item = next(
        (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
    )
    return item if item is not None and item.get("storage") == "native" else None


def _enum_var(item: dict) -> str:
    return f"{member_name(item['name'])}Enum"


def _precision_of(column_type: dict) -> str | None:
    match = re.search(r"\((\d+)\)", column_type["sql"])
    return match.group(1) if match else None


def _builder_of(context: dict, column: dict, imports: TsImports) -> str:
    """The column builder of a type, and the name it is imported by."""
    dialect = dialect_of(context)
    core = CORE[dialect]["module"]
    column_type = column["type"]
    name = quote(column["name"])

    def make(builder: str, options: str | None = None) -> str:
        imports.from_(core, builder)
        return f"{builder}({name}{', ' + options if options else ''})"

    def custom(builder: str, options: str | None = None) -> str:
        imports.from_("src/column-types", builder)
        return f"{builder}({name}{', ' + options if options else ''})"

    sqlite = dialect == "sqlite"
    postgres = dialect == "postgresql"
    kind = column_type["kind"]
    if kind == "integer":
        if sqlite:
            return make("integer")
        if column_type["bits"] == 64:
            return make("bigint", "{ mode: 'number' }")
        if column_type["bits"] == 16:
            return make("smallint")
        return make("integer" if postgres else "int")
    if kind == "decimal":
        options = None
        if column_type.get("precision") is not None:
            scale = column_type.get("scale")
            options = f"{{ precision: {column_type['precision']}, scale: {scale if scale is not None else 0} }}"
        return make("numeric") if sqlite else make("numeric" if postgres else "decimal", options)
    if kind == "float":
        if sqlite:
            return make("real")
        if column_type["bits"] == 32:
            return make("real" if postgres else "float")
        return make("doublePrecision" if postgres else "double")
    if kind == "text":
        if sqlite or column_type.get("length") is None:
            return make("text")
        return make("char" if column_type.get("fixed") else "varchar", f"{{ length: {column_type['length']} }}")
    if kind == "boolean":
        return make("integer", "{ mode: 'boolean' }") if sqlite else make("boolean")
    if kind == "date":
        if sqlite:
            return make("text")
        return make("date", None if postgres else "{ mode: 'string' }")
    if kind == "time":
        if sqlite:
            return make("text")
        precision = _precision_of(column_type)
        if postgres:
            options = [column_type.get("timezone") and "withTimezone: true", precision and f"precision: {precision}"]
        else:
            options = [precision and f"fsp: {precision}"]
        present = [item for item in options if item]
        return make("time", f"{{ {', '.join(present)} }}" if present else None)
    if kind == "datetime":
        if sqlite:
            return custom("datetime")
        precision = _precision_of(column_type)
        if postgres:
            options = [
                "mode: 'date'",
                column_type.get("timezone") and "withTimezone: true",
                precision and f"precision: {precision}",
            ]
            return make("timestamp", f"{{ {', '.join(item for item in options if item)} }}")
        options = ["mode: 'date'", precision and f"fsp: {precision}"]
        return make("datetime", f"{{ {', '.join(item for item in options if item)} }}")
    if kind == "uuid":
        if sqlite:
            return make("text")
        return make("uuid") if postgres else make("char", "{ length: 36 }")
    if kind == "binary":
        length = column_type.get("length")
        return custom("bytes", f"{{ length: {length} }}" if dialect == "mysql" and length is not None else None)
    if kind in ("json", "array"):
        if sqlite:
            return make("text", "{ mode: 'json' }")
        if postgres and not re.fullmatch(r"json", column_type["sql"], re.IGNORECASE):
            return make("jsonb")
        return make("json")
    if kind == "enum":
        item = native_enum(context, column_type)
        if item and postgres:
            return f"{_enum_var(item)}({name})"
        if item:
            imports.from_(core, "mysqlEnum")
            return f"mysqlEnum({name}, [{', '.join(quote(value) for value in item['values'])}])"
        return make("text")
    return make("text")


def _default_of(column: dict, imports: TsImports) -> str | None:
    value = column.get("default")
    if not value:
        return None
    if value["kind"] == "expression":
        imports.from_("drizzle-orm", "sql")
        return f".default(sql.raw({quote(value['sql'])}))"
    literal = value["value"]
    if literal is None:
        return None
    kind = column["type"]["kind"]
    if isinstance(literal, str):
        if kind == "integer" and re.fullmatch(r"-?\d+", literal):
            return f".default({literal})"
        # A date and time is written by the database from its text
        if kind == "datetime":
            imports.from_("drizzle-orm", "sql")
            text = "'" + literal.replace("'", "''") + "'"
            return f".default(sql.raw({quote(text)}))"
        return f".default({quote(literal)})"
    if not isinstance(literal, bool) and kind == "decimal":
        return f".default({quote(number_text(literal))})"
    return f".default({number_text(literal)})"


def _column_line(context: dict, info: dict, column: dict, imports: TsImports) -> list:
    db = column["column"]
    dialect = dialect_of(context)
    primary_key = info["table"].get("primaryKey")
    single = primary_key is not None and len(primary_key) == 1 and primary_key[0] == db["name"]
    parts = [_builder_of(context, db, imports)]
    if single:
        parts.append(".primaryKey()")
    if not db["nullable"] and not single:
        parts.append(".notNull()")
    generated = db.get("generated")
    if generated == "identity":
        if dialect == "postgresql":
            parts.append(".generatedByDefaultAsIdentity()")
        if dialect == "mysql":
            parts.append(".autoincrement()")
        # SQLite counts up an INTEGER PRIMARY KEY by itself
    elif generated == "uuid":
        if dialect == "postgresql":
            parts.append(".defaultRandom()")
        else:
            imports.from_("node:crypto", "randomUUID")
            parts.append(".$defaultFn(() => randomUUID())")
    elif generated in ("now", "onUpdateNow"):
        # MySQL's datetime has no defaultNow() in Drizzle
        if dialect == "postgresql":
            parts.append(".defaultNow()")
        else:
            imports.from_("drizzle-orm", "sql")
            parts.append(".default(sql`CURRENT_TIMESTAMP`)")
        if generated == "onUpdateNow":
            parts.append(".$onUpdate(() => new Date())")
    elif isinstance(generated, dict):
        imports.from_("drizzle-orm", "sql")
        mode = "" if dialect == "postgresql" else ", { mode: 'stored' }"
        parts.append(f".generatedAlwaysAs(sql.raw({quote(generated['computed'])}){mode})")
    else:
        value = _default_of(db, imports)
        if value:
            parts.append(value)
    kind = db["type"]["kind"]
    return [
        bool(db.get("comment")) and f"  /** {db['comment']} */",
        kind == "unknown" and f'  // TODO: "{db["type"]["sql"]}" has no Drizzle type here; it is mapped as text',
        kind == "array"
        and f'  // TODO: "{db["type"]["sql"]}" is mapped as JSON; use `.array()` on PostgreSQL if you need the native array',
        f"  {column['prop']}: {''.join(parts)},",
    ]


def _constraints(context: dict, info: dict, imports: TsImports) -> list[str]:
    """Keys, unique values, indexes, CHECK constraints and foreign keys, in the table's extra configuration."""
    core = CORE[dialect_of(context)]["module"]
    table = info["table"]

    def props(names: list[str]) -> str:
        return ", ".join(f"t.{column_of(info, name)['prop']}" for name in names)

    result = []
    primary_key = table.get("primaryKey")
    if primary_key and len(primary_key) > 1:
        imports.from_(core, "primaryKey")
        result.append(f"primaryKey({{ columns: [{props(primary_key)}] }})")
    for unique in table["uniques"]:
        imports.from_(core, "unique")
        name = quote(unique["name"]) if unique.get("name") else ""
        result.append(f"unique({name}).on({props(unique['columns'])})")
    for index in table["indexes"]:
        imports.from_(core, "index")
        # Drizzle names every index; the database's name when it has one
        name = index.get("name") or f"{table['name']}_{'_'.join(index['columns'])}_idx"
        result.append(f"index({quote(name)}).on({props(index['columns'])})")
    for position, check in enumerate(table["checks"]):
        imports.from_(core, "check").from_("drizzle-orm", "sql")
        name = check.get("name") or f"{table['name']}_check_{position + 1}"
        result.append(f"check({quote(name)}, sql.raw({quote(check['sql'])}))")
    for key in table["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if not parent:
            continue
        imports.from_(core, "foreignKey")
        target = "t" if parent is info else table_var(parent)
        foreign = ", ".join(f"{target}.{column_of(parent, name)['prop']}" for name in key["references"]["columns"])
        options = [
            *([f"name: {quote(key['name'])}"] if key.get("name") else []),
            f"columns: [{props(key['columns'])}]",
            f"foreignColumns: [{foreign}]",
        ]
        on_delete = f".onDelete('{key['onDelete']}')" if key.get("onDelete") else ""
        on_update = f".onUpdate('{key['onUpdate']}')" if key.get("onUpdate") else ""
        result.append(f"foreignKey({{ {', '.join(options)} }}){on_delete}{on_update}")
    return result


def _table_block(context: dict, info: dict, imports: TsImports) -> list:
    core = CORE[dialect_of(context)]
    imports.from_(core["module"], core["table"])
    columns = [line for column in info["columns"] for line in _column_line(context, info, column, imports)]
    extra = _constraints(context, info, imports)
    table = info["table"]
    comment = f": {table['comment']}" if table.get("comment") else ""
    return [
        f'/** The "{info["name"]}" table{comment}. */',
        not table.get("primaryKey")
        and "// The table has no primary key: rows are told apart by all their columns, for reading only",
        bool(table.get("schema"))
        and f'// TODO: the table is in the "{table.get("schema")}" schema; declare it with pgSchema("{table.get("schema")}").table',
        f"export const {table_var(info)} = {core['table']}(",
        f"  {quote(info['name'])},",
        "  {",
        *((f"  {line}" if isinstance(line, str) else line) for line in columns),
        "  }," if extra else "  }",
        *(["  (t) => [", *(f"    {item}," for item in extra), "  ],"] if extra else []),
        ")",
    ]


def schema_file(context: dict) -> dict:
    imports = TsImports("src/schema")
    dialect = dialect_of(context)
    used = []
    for info in context["tables"]:
        for column in info["columns"]:
            item = native_enum(context, column["column"]["type"])
            if item is not None and not any(item is other for other in used):
                used.append(item)
    enums = (
        [item for item in context["schema"]["enums"] if any(item is other for other in used)]
        if dialect == "postgresql"
        else []
    )
    if enums:
        imports.from_(CORE["postgresql"]["module"], "pgEnum")
    tables = [_table_block(context, info, imports) for info in context["tables"]]
    enum_lines = []
    for item in enums:
        values = ", ".join(quote(value) for value in item["values"])
        enum_lines += ["", f"export const {_enum_var(item)} = pgEnum({quote(item['name'])}, [{values}])"]
    content = lines(
        "/** The tables of the database, as Drizzle reads and writes them. They reflect the database: do not migrate with them. */",
        imports.write(),
        *enum_lines,
        *[line for block in tables for line in ("", *block)],
        "",
    )
    return {"path": "src/schema.ts", "content": content}


def column_types_file(context: dict) -> dict | None:
    """src/column-types.ts, when a column needs it: bytes, and dates SQLite keeps as text."""
    dialect = dialect_of(context)
    kinds = {
        column["column"]["type"]["kind"]
        for info in context["tables"]
        if info["writesEntity"]
        for column in info["columns"]
    }
    has_bytes = "binary" in kinds
    has_datetime = dialect == "sqlite" and "datetime" in kinds
    if not has_bytes and not has_datetime:
        return None
    core = CORE[dialect]["module"]
    if dialect == "postgresql":
        bytes_type = "  dataType: () => 'bytea',"
    elif dialect == "mysql":
        bytes_type = "  dataType: (config) => (config?.length !== undefined ? `varbinary(${config.length})` : 'blob'),"
    else:
        bytes_type = "  dataType: () => 'blob',"
    config = "; config: { length?: number }" if dialect == "mysql" else ""
    return {
        "path": "src/column-types.ts",
        "content": lines(
            "/** Column types Drizzle does not have for this database. */",
            f"import {{ customType }} from '{core}'",
            has_bytes
            and [
                "",
                "/** Bytes, as a Buffer. */",
                f"export const bytes = customType<{{ data: Buffer; driverData: Buffer{config} }}>({{",
                bytes_type,
                "})",
            ],
            has_datetime
            and [
                "",
                "/** A date and time SQLite keeps as text (`2026-01-31 12:00:00`, in UTC), as a Date. */",
                "export const datetime = customType<{ data: Date; driverData: string }>({",
                "  dataType: () => 'datetime',",
                "  toDriver: (value) => value.toISOString(),",
                "  fromDriver: (value) => new Date(/[zZ]|[+-]\\d\\d:?\\d\\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`),",
                "})",
            ],
            "",
        ),
    }
