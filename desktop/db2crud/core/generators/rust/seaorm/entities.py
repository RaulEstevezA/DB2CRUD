"""The entity of each table (a plain struct with a field per column, every one of them None until it is set) and its
SeaORM module, which describes the table as the database has it: exact table and column names, types with their
lengths and precision, the key, unique values, foreign keys with their actions, defaults and the values the database
fills. SeaORM reads and writes rows through that module; the repositories turn its models into entities and back. CHECK
constraints are named in the module's documentation: the services check them. Mirrors
web/src/core/generators/rust/seaorm/entities.ts."""

import re

from ....js import js_string
from ....schema.ddl import type_sql
from ..context import column_of, file_of, find_info, is_in, module_of, rs_file, stored_type
from ..rust import rs_string


def entity_file(context: dict, info: dict) -> dict:
    module = module_of(context, info, "entity")
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    return rs_file(
        file_of(module),
        "",
        [
            f'/// A row of the "{info["name"]}" table{comment}. A field stays `None` until it is set or read.',
            "#[derive(Debug, Clone, Default, PartialEq)]",
            f"pub struct {info['entity']} {{",
            *(f"    pub {column['field']}: Option<{column['rs']}>," for column in info["columns"]),
            "}",
        ],
    )


def native_enum(context: dict, column: dict) -> dict | None:
    """The enum of the database a column holds, when the database keeps it as a type of its own."""
    column_type = column["type"]
    if column_type["kind"] != "enum" or context["settings"]["database"] == "sqlite":
        return None
    item = next(
        (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
    )
    return item if item and item.get("storage") == "native" else None


def _quote_sql(text: str) -> str:
    escaped = text.replace("'", "''")
    return f"'{escaped}'"


def _native_text(context: dict, column: dict) -> str | None:
    """The type of PostgreSQL of a column kept as its text: JSON, an array, or a type SeaORM does not know."""
    column_type = column["column"]["type"]
    if context["settings"]["database"] != "postgresql" or column_type["kind"] not in ("json", "array", "unknown"):
        return None
    return type_sql(context["schema"], "postgresql", column_type)


def _is_mysql(dialect: str | None) -> bool:
    return dialect in ("mysql", "mariadb")


def _is_maria_uuid(context: dict, column: dict) -> bool:
    """A column of MariaDB's own uuid type; the driver sends and reads the 16 bytes of one."""
    return (
        column["type"]["kind"] == "uuid"
        and context["settings"]["database"] == "mariadb"
        and context["schema"].get("dialect") == "mariadb"
        and column["type"]["sql"].lower() == "uuid"
    )


def _column_type(context: dict, column: dict) -> str | None:
    """The column_type of a column, when its Rust type alone does not say it."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    enum_type = native_enum(context, column["column"])
    if enum_type:
        # The entity keeps its text; the column is the enum, so the tests create it as the database has it
        if context["settings"]["database"] == "postgresql":
            sql = f'"{enum_type["name"]}"'
        else:
            sql = f"ENUM({', '.join(_quote_sql(value) for value in enum_type['values'])})"
        return f"custom({rs_string(sql)})"
    if kind == "text":
        if column_type.get("length") is None:
            return "Text"
        length = js_string(column_type["length"])
        return f"Char(Some({length}))" if column_type.get("fixed") else f"String(StringLen::N({length}))"
    if kind == "decimal":
        precision = column_type.get("precision")
        scale = column_type.get("scale")
        return f"Decimal(Some(({js_string(10 if precision is None else precision)}, {js_string(0 if scale is None else scale)})))"
    if kind == "uuid":
        return 'custom("uuid")' if _is_maria_uuid(context, column["column"]) else None
    if kind == "binary":
        return f"Binary({js_string(column_type['length'])})" if column_type.get("length") is not None else None
    if kind == "enum":
        # An enum kept with a CHECK: its text, as long as its longest value
        values = next(
            (item["values"] for item in context["schema"]["enums"] if item["name"] == column_type["name"]), []
        )
        return f"String(StringLen::N({max([1, *(len(value) for value in values)])}))"
    if kind in ("json", "array", "unknown"):
        native = _native_text(context, column)
        return f"custom({rs_string(native)})" if native else "Text"
    return None


def _attributes(context: dict, info: dict, column: dict, key_columns: list[dict]) -> tuple[list[str], list[str]]:
    """The SeaORM attributes of a column, and the TODOs it needs."""
    db = column["column"]
    attrs: list[str] = []
    todo: list[str] = []
    primary_key = info["table"]["primaryKey"]
    generated = db.get("generated")
    default = db.get("default")
    if is_in(column, key_columns):
        attrs.append("primary_key")
        single = primary_key is not None and len(primary_key) == 1 and generated == "identity"
        if not single:
            attrs.append("auto_increment = false")
    if re.sub(r"^r#", "", column["field"]) != db["name"]:
        attrs.append(f"column_name = {rs_string(db['name'])}")
    column_type = _column_type(context, column)
    if column_type:
        attrs.append(f"column_type = {rs_string(column_type)}")
    enum_type = native_enum(context, db)
    if enum_type and context["settings"]["database"] == "postgresql":
        # PostgreSQL takes and gives a value of the enum, not a text
        attrs += ['select_as = "text"', f"save_as = {rs_string(chr(34) + enum_type['name'] + chr(34))}"]
    native = _native_text(context, column)
    # Kept as its text, which PostgreSQL converts only when it is told to
    if native:
        attrs += ['select_as = "text"', f"save_as = {rs_string(native)}"]
    database = context["settings"]["database"]
    dialect = context["schema"].get("dialect")
    mysql = _is_mysql(database) and _is_mysql(dialect)
    kind = db["type"]["kind"]
    sql = db["type"]["sql"].lower()
    # The driver gives each type of MySQL only as its own Rust type: the others are converted by the database
    if mysql and kind == "integer" and "unsigned" in sql:
        attrs.append('select_as = "signed"')
    if mysql and kind == "json":
        attrs.append('select_as = "char"')
    if mysql and kind == "datetime" and sql.startswith("timestamp"):
        attrs.append('select_as = "datetime(6)"')
    if database == "postgresql" and kind == "time" and db["type"].get("timezone"):
        attrs += ['select_as = "time"', 'save_as = "timetz"']
    # SQLite keeps 3.00 as a whole number
    if database == "sqlite" and dialect == "sqlite" and kind == "decimal":
        attrs.append('select_as = "real"')
    if _is_maria_uuid(context, db):
        attrs += ['select_as = "binary(16)"', 'save_as = "uuid"']
    if db["nullable"]:
        attrs.append("nullable")
    for unique in info["table"]["uniques"]:
        if db["name"] not in unique["columns"]:
            continue
        if len(unique["columns"]) == 1:
            attrs.append("unique")
        else:
            attrs.append(
                f"unique_key = {rs_string(unique['name'] if unique.get('name') is not None else '_'.join(unique['columns']))}"
            )
    if any(len(index["columns"]) == 1 and index["columns"][0] == db["name"] for index in info["table"]["indexes"]):
        attrs.append("indexed")
    if generated == "identity" and not (
        primary_key is not None and len(primary_key) == 1 and primary_key[0] == db["name"]
    ):
        todo.append("// TODO: the database numbers this column; SeaORM numbers only a key of one column")
    if generated in ("now", "onUpdateNow"):
        now = (
            "Expr::current_date()"
            if column_type is None and db["type"]["kind"] == "date"
            else "Expr::current_timestamp()"
        )
        attrs.append(f"default_expr = {rs_string(now)}")
        if generated == "onUpdateNow":
            todo.append("// TODO: the database sets it again on every change; SeaORM only reads it")
    elif isinstance(generated, dict):
        attrs.append(f"extra = {rs_string('GENERATED ALWAYS AS (' + generated['computed'] + ') STORED')}")
    elif default is not None and default["kind"] == "literal" and default.get("value") is not None:
        value = default["value"]
        attrs.append(f"default_value = {rs_string(value) if isinstance(value, str) else js_string(value)}")
    elif default is not None and default["kind"] == "expression":
        attrs.append(f"default_expr = {rs_string('Expr::cust(' + rs_string(default['sql']) + ')')}")
        todo.append(
            f"// TODO: the database fills it with {default['sql']} on insert; the repository never sends a value for it"
        )
    if db.get("comment") and context["settings"]["database"] != "sqlite":
        attrs.append(f"comment = {rs_string(db['comment'])}")
    return attrs, todo


def _indexable(column: dict) -> bool:
    """Columns a database can index whole: not text or bytes without a length (MySQL cannot key those)."""
    column_type = column["column"]["type"]
    if column_type["kind"] in ("text", "binary"):
        return column_type.get("length") is not None
    return column_type["kind"] not in ("json", "array", "unknown")


def mapped_key(info: dict) -> list[dict]:
    """The columns SeaORM keys a table by: its primary key, or, when it has none, the columns that cannot be null and
    can be indexed (or, failing those, every column that cannot be null)."""
    if info["table"]["primaryKey"] is not None:
        return info["key"]
    columns = [column for column in info["columns"] if not column["column"]["nullable"]]
    keyable = [column for column in columns if _indexable(column)]
    if keyable:
        return keyable
    return columns if columns else info["columns"]


ACTIONS = {
    "cascade": "Cascade",
    "set null": "SetNull",
    "set default": "SetDefault",
    "restrict": "Restrict",
    "no action": "NoAction",
}


def table_file(context: dict, info: dict) -> dict:
    module = module_of(context, info, "table")
    table = info["table"]
    key_columns = mapped_key(info)
    fields: list[str] = []
    for column in info["columns"]:
        attrs, todo = _attributes(context, info, column, key_columns)
        fields += [
            *todo,
            *([f"#[sea_orm({', '.join(attrs)})]"] if attrs else []),
            f"pub {column['field']}: {stored_type(column)},",
        ]
    relations: list[str] = []
    notes: list[str] = []
    variants: set[str] = set()
    for key in table["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if not parent:
            notes.append(
                f"// TODO: {', '.join(key['columns'])} points to {key['references']['table']}, a table this project does not have"
            )
            continue
        if parent is not info and parent["writesEntity"] != info["writesEntity"]:
            continue

        def columns(names: list[str], of: dict, prefix: str) -> str:
            items = [f"{prefix}Column::{column_of(of, name)['variant']}" for name in names]
            return items[0] if len(items) == 1 else f"({', '.join(items)})"

        parent_module = "" if parent is info else f"{module_of(context, parent, 'table')}::"
        variant = "".join(column_of(info, name)["variant"] for name in key["columns"])
        while variant in variants:
            variant += "Key"
        variants.add(variant)
        args = [
            f"belongs_to = {rs_string(parent_module + 'Entity')}",
            f"from = {rs_string(columns(key['columns'], info, ''))}",
            f"to = {rs_string(columns(key['references']['columns'], parent, parent_module))}",
            *([f"on_delete = {rs_string(ACTIONS[key['onDelete']])}"] if key.get("onDelete") else []),
        ]
        relations += [f"    #[sea_orm({', '.join(args)})]", f"    {variant},"]
    for index in table["indexes"]:
        if len(index["columns"]) > 1:
            note = f"// TODO: the index {index['name'] if index.get('name') is not None else ''} on {', '.join(index['columns'])} is not described: SeaORM describes indexes of one column"
            notes.append(note.replace("  ", " ", 1))
    checks = [f"CHECK ({check['sql']}): the services check what they understand of it." for check in table["checks"]]
    schema_name = f"schema_name = {rs_string(table['schema'])}, " if table.get("schema") else ""
    key_names = ", ".join(column["key"] for column in key_columns)
    return rs_file(
        file_of(module),
        "use sea_orm::entity::prelude::*;",
        [
            *notes,
            *([""] if notes else []),
            "#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]",
            f"#[sea_orm({schema_name}table_name = {rs_string(table['name'])})]",
            "pub struct Model {",
            *(f"    {line}" for line in fields),
            "}",
            "",
            "#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]",
            "pub enum Relation {" if relations else "pub enum Relation {}",
            *([*relations, "}"] if relations else []),
            "",
            "impl ActiveModelBehavior for ActiveModel {}",
        ],
        [
            f'The "{table["name"]}" table, as the database has it. SeaORM never creates or changes it: the database already exists.',
            *(["", *checks] if checks else []),
            *(
                []
                if table["primaryKey"] is not None
                else ["", f"It has no primary key: SeaORM keys its rows by {key_names}."]
            ),
        ],
    )
