"""The entity of each table for Doctrine ORM 3: a class with a public property per column and attributes that map it as
the database has it. Doctrine maps no CHECK constraints and, without associations, no foreign keys: the entity names
them in its comment, the services check them, and the tests add the foreign keys to the database they create. Mirrors
web/src/core/generators/php/doctrine/entities.ts."""

import re

from ....schema.ddl import type_sql
from ..common.context import is_in, namespace_of, optional_type, path_of, php_file
from ..common.php import php_literal, php_string
from ..common.repositories import default_literal
from .types import PG_ARRAY, PRECISE, PRECISE_TIME_TZ, PRECISE_TZ

DATE_TIME = "\\DateTimeImmutable"


def doctrine_php_type(column_type: dict) -> str:
    """The PHP type of a value as Doctrine reads it."""
    kind = column_type["kind"]
    if kind == "integer":
        return "int"
    if kind == "float":
        return "float"
    if kind == "boolean":
        return "bool"
    if kind in ("date", "time", "datetime"):
        return DATE_TIME
    # DBAL reads binary columns as a stream (a resource) and JSON as what it decodes to
    if kind in ("binary", "json", "array"):
        return "mixed"
    # Decimals as text, so no precision is lost
    return "string"


def _is_text_date(column: dict) -> bool:
    return column["php"] == "string" and column["column"]["type"]["kind"] in ("date", "time", "datetime")


def _dbal_type(context: dict, column: dict) -> dict:
    """The DBAL type of a column, with its length or precision."""
    column_type = column["column"]["type"]
    # A date of a key: text (textDateKeys of the ORM)
    if _is_text_date(column):
        return {"name": "string"}
    postgres = context["settings"]["database"] == "postgresql"
    kind = column_type["kind"]
    if kind == "integer":
        return {"name": {16: "smallint", 64: "bigint"}.get(column_type["bits"], "integer")}
    if kind == "decimal":
        precision = column_type.get("precision")
        scale = column_type.get("scale")
        return {
            "name": "decimal",
            "precision": 10 if precision is None else precision,
            "scale": 0 if scale is None else scale,
        }
    if kind == "float":
        return {"name": "smallfloat" if column_type["bits"] == 32 else "float"}
    if kind == "text":
        if column_type.get("length") is not None:
            return {"name": "string", "length": column_type["length"], "fixed": column_type.get("fixed")}
        return {"name": "text"}
    if kind == "boolean":
        return {"name": "boolean"}
    if kind == "date":
        return {"name": "date_immutable"}
    if kind == "time":
        return {"name": PRECISE_TIME_TZ if column_type.get("timezone") and postgres else "time_immutable"}
    if kind == "datetime":
        # DBAL's own timestamps expect no fractions of a second, which a real database often keeps (types.py)
        return {"name": PRECISE_TZ if column_type.get("timezone") else PRECISE}
    if kind == "uuid":
        return {"name": "guid"}
    if kind == "binary":
        if column_type.get("length") is not None:
            return {"name": "binary", "length": column_type["length"]}
        return {"name": "blob"}
    if kind == "array":
        return {"name": PG_ARRAY if postgres else "json"}
    if kind == "json":
        return {"name": "json"}
    return {"name": "string"}


RESERVED = set(
    (
        "all and any as asc between by case check column constraint create cross current_date current_time "
        "current_timestamp default delete desc distinct drop else end except exists false fetch for foreign from full "
        "grant group having in index inner insert intersect into is join key left like limit not null offset on or order "
        "outer primary range rank references right row rows select set table then to true union unique update user "
        "using values when where window with "
        # Words of MySQL and MariaDB, then of PostgreSQL
        "accessible add alter analyze before bigint binary blob both by call cascade change char character collate condition "
        "continue convert cube cume_dist cursor database databases day_hour day_minute day_second dec decimal declare delayed "
        "dense_rank describe deterministic distinctrow div double dual each elseif empty enclosed escaped exit explain first_value "
        "float force fulltext function generated get grouping groups high_priority if ignore infile inout insensitive int integer "
        "interval io_after_gtids iterate json_table keys kill lag last_value lateral lead leading leave linear lines load localtime "
        "localtimestamp lock long longblob longtext loop low_priority match mediumblob mediumint mediumtext middleint mod modifies "
        "natural nth_value ntile numeric of optimize option optionally out outfile over partition percent_rank precision procedure "
        "purge read reads real recursive regexp release rename repeat replace require resignal return revoke rlike row_number schema "
        "schemas sensitive separator show signal smallint spatial specific sql sqlexception sqlstate sqlwarning ssl starting stored "
        "straight_join system terminated tinyblob tinyint tinytext trailing trigger undo unlock unsigned usage use utc_date utc_time "
        "utc_timestamp varbinary varchar varying virtual while write xor year_month zerofill "
        "array asymmetric collation concurrently current_catalog current_role current_schema current_user deferrable do freeze ilike "
        "initially isnull notnull only overlaps placing returning session_user similar some symmetric tablesample variadic verbose"
    ).split(" ")
)


def quoted(name: str) -> str:
    """A name as Doctrine takes it: in backticks when it is a word of SQL, so Doctrine quotes it."""
    if name.lower() in RESERVED or not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
        return f"`{name}`"
    return name


def _quote_sql(text: str) -> str:
    escaped = text.replace("'", "''")
    return f"'{escaped}'"


def _native_enum(context: dict, column: dict) -> dict | None:
    """The enum of the database a column holds, when the database keeps it as a type of its own."""
    column_type = column["column"]["type"]
    if column_type["kind"] != "enum" or context["settings"]["database"] == "sqlite":
        return None
    item = next(
        (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
    )
    return item if item and item.get("storage") == "native" else None


def id_columns(info: dict) -> list[dict]:
    """The columns of a table Doctrine identifies its rows by: the primary key, or, for a table without one, the columns
    that can be compared as text (Doctrine keys its rows by their identifier)."""
    if info["table"]["primaryKey"] is not None:
        return info["key"]
    comparable = [column for column in info["key"] if column["php"] not in (DATE_TIME, "mixed")]
    return comparable or info["key"]


def _column_lines(context: dict, info: dict, column: dict) -> list:
    db = column["column"]
    dbal = _dbal_type(context, column)
    args = [f"name: {php_string(quoted(db['name']))}", f"type: {php_string(dbal['name'])}"]
    if dbal.get("length") is not None:
        args.append(f"length: {dbal['length']}")
    if dbal.get("precision") is not None:
        args.extend([f"precision: {dbal['precision']}", f"scale: {dbal['scale']}"])
    if db["nullable"]:
        args.append("nullable: true")
    options = []
    if dbal.get("fixed"):
        options.append("'fixed' => true")
    todo = []
    primary = is_in(column, info["key"]) and info["table"]["primaryKey"] is not None
    generated = db.get("generated")
    identity = generated == "identity" and primary
    definition = None
    not_null = "" if db["nullable"] else " NOT NULL"
    default = db.get("default")
    if generated in ("now", "onUpdateNow"):
        args.extend(
            [
                "insertable: false",
                "updatable: false",
                f"generated: {php_string('INSERT' if generated == 'now' else 'ALWAYS')}",
            ]
        )
        options.append("'default' => 'CURRENT_TIMESTAMP'")
    elif isinstance(generated, dict):
        args.extend(["insertable: false", "updatable: false", "generated: 'ALWAYS'"])
        definition = f"{db['type']['sql']} GENERATED ALWAYS AS ({generated['computed']}) STORED"
    elif generated == "identity" and not identity:
        args.extend(["insertable: false", "updatable: false", "generated: 'INSERT'"])
        todo.append("// TODO: the database numbers this column; Doctrine can only number a single-column key itself")
    elif default and default["kind"] == "literal" and default["value"] is not None:
        options.append(f"'default' => {php_literal(default['value'])}")
    elif default and default["kind"] == "expression":
        args.extend(["insertable: false", "generated: 'INSERT'"])
        definition = f"{db['type']['sql']}{not_null} DEFAULT {default['sql']}"
        todo.append(
            f"// TODO: the database fills it on insert with {default['sql']}; Doctrine sends no value for it then"
        )
    if definition is None and (_is_text_date(column) or dbal["name"] in (PG_ARRAY, PRECISE_TIME_TZ)):
        definition = f"{type_sql(context['schema'], context['settings']['database'], db['type'])}{not_null}"
    enum_type = _native_enum(context, column)
    if enum_type:
        if context["settings"]["database"] == "postgresql":
            definition = f'"{enum_type["name"]}"{not_null}'
        else:
            definition = f"ENUM({', '.join(_quote_sql(value) for value in enum_type['values'])}){not_null}"
    if db.get("comment"):
        options.append(f"'comment' => {php_string(db['comment'])}")
    if definition:
        args.append(f"columnDefinition: {php_string(definition)}")
    if options:
        args.append(f"options: [{', '.join(options)}]")
    if db["type"]["kind"] == "unknown":
        todo.append(f'// TODO: "{db["type"]["sql"]}" has no Doctrine type here; it is mapped as text')
    if db["type"]["kind"] == "array" and dbal["name"] != PG_ARRAY:
        todo.append(f'// TODO: "{db["type"]["sql"]}" is kept as JSON')
    literal = default and default["kind"] == "literal" and default["value"] is not None
    initial = (
        default_literal(column, default["value"]) if literal and column["php"] not in (DATE_TIME, "mixed") else "null"
    )
    comment = db.get("comment")
    return [
        comment and f"    /** {comment} */",
        *(f"    {line}" for line in todo),
        "    #[ORM\\Id]" if is_in(column, id_columns(info)) else None,
        "    #[ORM\\GeneratedValue(strategy: 'IDENTITY')]" if identity else None,
        f"    #[ORM\\Column({', '.join(args)})]",
        f"    public {optional_type(column)} ${column['prop']} = {initial};",
    ]


def _column_list(names: list[str]) -> str:
    return "[" + ", ".join(php_string(quoted(name)) for name in names) + "]"


def doctrine_entity_file(context: dict, info: dict) -> dict:
    ns = namespace_of(context, info, "entity")
    table = info["table"]
    notes = []
    for key in table["foreignKeys"]:
        on_delete = f", on delete {key['onDelete']}" if key.get("onDelete") else ""
        notes.append(
            f" * Foreign key: {', '.join(key['columns'])} → {key['references']['table']}"
            f"({', '.join(key['references']['columns'])}){on_delete}."
        )
    notes.extend(
        f" * CHECK ({check['sql']}): the service checks what it understands of it." for check in table["checks"]
    )
    if table["primaryKey"] is None:
        apart = ", ".join(column["column"]["name"] for column in id_columns(info))
        notes.append(f" * The table has no primary key: Doctrine tells its rows apart by {apart}.")
    table_args = [f"name: {php_string(quoted(table['name']))}"]
    if table.get("schema"):
        table_args.append(f"schema: {php_string(table['schema'])}")
    comment = f": {table['comment']}" if table.get("comment") else ""
    body = [
        "/**",
        f' * A row of the "{table["name"]}" table{comment}.',
        *([" *", *notes] if notes else []),
        " */",
        "#[ORM\\Entity]",
        f"#[ORM\\Table({', '.join(table_args)})]",
    ]
    for unique in table["uniques"]:
        name = f"name: {php_string(unique['name'])}, " if unique.get("name") else ""
        body.append(f"#[ORM\\UniqueConstraint({name}columns: {_column_list(unique['columns'])})]")
    for index in table["indexes"]:
        name = f"name: {php_string(index['name'])}, " if index.get("name") else ""
        body.append(f"#[ORM\\Index({name}columns: {_column_list(index['columns'])})]")
    body.extend([f"class {info['entity']}", "{"])
    for position, column in enumerate(info["columns"]):
        if position > 0:
            body.append("")
        body.extend(_column_lines(context, info, column))
    body.append("}")
    return php_file(
        path_of(ns, info["entity"]),
        ns,
        "use Doctrine\\ORM\\Mapping as ORM;",
        [line for line in body if isinstance(line, str)],
    )


def pg_enums(context: dict) -> list[dict]:
    """The enums of PostgreSQL the tables use, which the tests create before the tables."""
    if context["settings"]["database"] != "postgresql":
        return []
    return [
        item
        for item in context["schema"]["enums"]
        if any(_native_enum(context, column) is item for info in context["tables"] for column in info["columns"])
    ]
