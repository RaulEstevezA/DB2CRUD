"""The SQL that creates a schema in a database, and the SQL that removes it: what the generated projects without an
ORM run before their tests, since nothing else creates their tables. Each engine gets its own types, keys, defaults,
generated columns and CHECK constraints. A schema read from the same engine keeps its types as declared; one read from
another engine gets the closest types of this one, and what only that engine understands (a default or a CHECK in its
own SQL) is left out. Mirrors web/src/core/schema/ddl.ts."""

import re

from ..js import js_string

_MYSQL = {"mysql", "mariadb"}


def quote_name(dialect: str, name: str) -> str:
    """A name between the quotes of the engine."""
    if dialect in _MYSQL:
        return "`" + name.replace("`", "``") + "`"
    return '"' + name.replace('"', '""') + '"'


def table_name(dialect: str, table: dict) -> str:
    """The name of a table, with its namespace on PostgreSQL."""
    if table.get("schema") and dialect == "postgresql":
        return f"{quote_name(dialect, table['schema'])}.{quote_name(dialect, table['name'])}"
    return quote_name(dialect, table["name"])


def _quote_text(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def creation_order(schema: dict) -> list[dict]:
    """The tables in the order they can be created: the tables they point to first (a cycle keeps the input's
    order)."""
    order: list[dict] = []

    def visit(table: dict, path: set[str]) -> None:
        if any(item is table for item in order) or table["name"] in path:
            return
        path.add(table["name"])
        for key in table["foreignKeys"]:
            parent = next((item for item in schema["tables"] if item["name"] == key["references"]["table"]), None)
            if parent is not None and parent is not table:
                visit(parent, path)
        order.append(table)

    for table in schema["tables"]:
        visit(table, set())
    return order


def type_sql(schema: dict, dialect: str, type_: dict) -> str:
    """The type of a column in the engine."""
    kind = type_["kind"]
    if schema.get("dialect") == dialect and kind not in ("enum", "unknown"):
        return type_["sql"]
    mysql = dialect in _MYSQL
    sqlite = dialect == "sqlite"
    if kind == "integer":
        if sqlite:
            return "INTEGER"
        return "SMALLINT" if type_["bits"] == 16 else "BIGINT" if type_["bits"] == 64 else "INTEGER"
    if kind == "decimal":
        if type_.get("precision") is not None:
            return f"DECIMAL({type_['precision']}, {type_.get('scale') or 0})"
        return "NUMERIC" if sqlite else "DECIMAL(38, 10)"
    if kind == "float":
        if sqlite:
            return "REAL"
        if mysql:
            return "FLOAT" if type_["bits"] == 32 else "DOUBLE"
        return "REAL" if type_["bits"] == 32 else "DOUBLE PRECISION"
    if kind == "text":
        if type_.get("length") is not None:
            return f"{'CHAR' if type_.get('fixed') else 'VARCHAR'}({type_['length']})"
        return "TEXT"
    if kind == "boolean":
        return "BOOLEAN"
    if kind == "date":
        return "DATE"
    if kind == "time":
        return "TIME WITH TIME ZONE" if dialect == "postgresql" and type_.get("timezone") else "TIME"
    if kind == "datetime":
        if mysql:
            return "DATETIME(6)"
        if sqlite:
            return "DATETIME"
        return "TIMESTAMP WITH TIME ZONE" if type_.get("timezone") else "TIMESTAMP"
    if kind == "uuid":
        return "UUID" if dialect == "postgresql" else "CHAR(36)" if mysql else "TEXT"
    if kind == "binary":
        if dialect == "postgresql":
            return "BYTEA"
        return f"VARBINARY({type_['length']})" if mysql and type_.get("length") is not None else "BLOB"
    if kind == "json":
        return "JSONB" if dialect == "postgresql" else "JSON" if mysql else "TEXT"
    if kind == "enum":
        item = next((candidate for candidate in schema["enums"] if candidate["name"] == type_["name"]), None)
        if item and item["storage"] == "native" and dialect == "postgresql":
            return quote_name(dialect, item["name"])
        if item and item["storage"] == "native" and mysql:
            return f"ENUM({', '.join(_quote_text(value) for value in item['values'])})"
        values = item["values"] if item else []
        return f"VARCHAR({max([1, *(len(value) for value in values)])})"
    if kind == "array":
        if dialect == "postgresql":
            return f"{type_sql(schema, dialect, type_['items'])}[]"
        return "JSON" if mysql else "TEXT"
    return type_["sql"] if schema.get("dialect") == dialect else "TEXT"


# The whole number of each serial type of PostgreSQL
_SERIALS = {
    "SMALLSERIAL": "SMALLINT",
    "SERIAL": "INTEGER",
    "BIGSERIAL": "BIGINT",
    "SERIAL2": "SMALLINT",
    "SERIAL4": "INTEGER",
    "SERIAL8": "BIGINT",
}


def _is_identity(table: dict, column: dict) -> bool:
    """Whether the column is the one key column the engine numbers by itself."""
    key = table.get("primaryKey")
    return column.get("generated") == "identity" and key is not None and len(key) == 1 and key[0] == column["name"]


def _literal(value) -> str:
    if isinstance(value, str):
        return _quote_text(value)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return js_string(value)


def _column_sql(schema: dict, dialect: str, table: dict, column: dict) -> str:
    """What a column is declared with after its type: identity, null, its default or its expression."""
    mysql = dialect in _MYSQL
    identity = _is_identity(table, column)
    # SQLite numbers a key only when it is exactly INTEGER PRIMARY KEY
    if identity and dialect == "sqlite":
        return f"{quote_name(dialect, column['name'])} INTEGER PRIMARY KEY AUTOINCREMENT"
    # A serial type numbers the column already: as an identity it is the whole number it stands for
    declared = type_sql(schema, dialect, column["type"])
    type_text = _SERIALS.get(declared.upper(), declared) if identity else declared
    parts = [quote_name(dialect, column["name"]), type_text]
    if identity:
        parts.append("AUTO_INCREMENT" if mysql else "GENERATED BY DEFAULT AS IDENTITY")
    generated = column.get("generated")
    if isinstance(generated, dict):
        parts.append(f"GENERATED ALWAYS AS ({generated['computed']}) STORED")
        return " ".join(parts)
    if not column["nullable"]:
        parts.append("NOT NULL")
    precise = mysql and type_text == "DATETIME(6)"
    is_date = column["type"]["kind"] == "date"
    now = "CURRENT_DATE" if is_date else "CURRENT_TIMESTAMP(6)" if precise else "CURRENT_TIMESTAMP"
    default = column.get("default")
    if generated in ("now", "onUpdateNow"):
        parts.append(f"DEFAULT {'(CURRENT_DATE)' if is_date and mysql else now}")
        if generated == "onUpdateNow" and mysql:
            parts.append(f"ON UPDATE {now}")
    elif generated == "uuid" and dialect == "postgresql":
        parts.append("DEFAULT gen_random_uuid()")
    elif default and default["kind"] == "literal" and default["value"] is not None:
        literal = _literal(default["value"])
        # MySQL takes a default for TEXT, BLOB and JSON only as an expression
        expression = mysql and re.match(r"^(TEXT|BLOB|JSON|LONGTEXT|MEDIUMTEXT)", type_text, re.IGNORECASE)
        parts.append(f"DEFAULT {f'({literal})' if expression else literal}")
    elif default and default["kind"] == "expression":
        if schema.get("dialect") == dialect:
            parts.append(f"DEFAULT {default['sql']}")
        elif re.match(r"^(now\(\)|current_timestamp(\(\d*\))?)$", default["sql"].strip(), re.IGNORECASE):
            parts.append(f"DEFAULT {now}")
    return " ".join(parts)


def _check_sql(schema: dict, dialect: str, check: dict) -> str | None:
    """A CHECK the engine understands: the forms the rules read are written again, the others only on their own
    engine."""
    parsed = check.get("parsed")
    condition = None
    if parsed and parsed["kind"] == "in":
        values = ", ".join(
            _quote_text(value) if isinstance(value, str) else js_string(value) for value in parsed["values"]
        )
        condition = f"{quote_name(dialect, parsed['column'])} IN ({values})"
    elif parsed and parsed["kind"] == "compare":
        condition = f"{quote_name(dialect, parsed['column'])} {parsed['op']} {js_string(parsed['value'])}"
    elif parsed and parsed["kind"] == "length":
        function = "CHAR_LENGTH" if dialect in _MYSQL else "LENGTH"
        condition = f"{function}({quote_name(dialect, parsed['column'])}) {parsed['op']} {js_string(parsed['value'])}"
    elif schema.get("dialect") == dialect:
        condition = check["sql"]
    if condition is None:
        return None
    name = f"CONSTRAINT {quote_name(dialect, check['name'])} " if check.get("name") else ""
    return f"{name}CHECK ({condition})"


_ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET NULL",
    "set default": "SET DEFAULT",
    "restrict": "RESTRICT",
    "no action": "NO ACTION",
}


def _foreign_key_sql(schema: dict, dialect: str, key: dict) -> str:
    parent = next((item for item in schema["tables"] if item["name"] == key["references"]["table"]), None)
    target = table_name(
        dialect, parent or {"name": key["references"]["table"], "schema": key["references"].get("schema")}
    )

    def columns(names: list[str]) -> str:
        return ", ".join(quote_name(dialect, item) for item in names)

    return "".join(
        [
            f"CONSTRAINT {quote_name(dialect, key['name'])} " if key.get("name") else "",
            f"FOREIGN KEY ({columns(key['columns'])}) REFERENCES {target} ({columns(key['references']['columns'])})",
            f" ON DELETE {_ACTIONS[key['onDelete']]}" if key.get("onDelete") else "",
            f" ON UPDATE {_ACTIONS[key['onUpdate']]}" if key.get("onUpdate") else "",
        ]
    )


def create_statements(schema: dict, dialect: str) -> list[str]:
    """The statements that create every table of the schema, in an order the engine accepts."""
    statements: list[str] = []
    if dialect == "postgresql":
        namespaces = list(dict.fromkeys(table["schema"] for table in schema["tables"] if table.get("schema")))
        statements += [f"CREATE SCHEMA IF NOT EXISTS {quote_name(dialect, name)}" for name in namespaces]
        for item in schema["enums"]:
            if item["storage"] == "native":
                values = ", ".join(_quote_text(value) for value in item["values"])
                statements.append(f"CREATE TYPE {quote_name(dialect, item['name'])} AS ENUM ({values})")
    created: set[str] = set()
    later: list[str] = []

    for table in creation_order(schema):

        def columns(names: list[str]) -> str:
            return ", ".join(quote_name(dialect, item) for item in names)

        parts = [_column_sql(schema, dialect, table, column) for column in table["columns"]]
        sqlite_key = dialect == "sqlite" and any(_is_identity(table, column) for column in table["columns"])
        if table.get("primaryKey") and not sqlite_key:
            parts.append(f"PRIMARY KEY ({columns(table['primaryKey'])})")
        for unique in table["uniques"]:
            name = f"CONSTRAINT {quote_name(dialect, unique['name'])} " if unique.get("name") else ""
            parts.append(f"{name}UNIQUE ({columns(unique['columns'])})")
        for check in table["checks"]:
            sql = _check_sql(schema, dialect, check)
            if sql:
                parts.append(sql)
        for key in table["foreignKeys"]:
            # A key to a table created later (a cycle) is added at the end, where the engine allows it
            pending = key["references"]["table"] not in created and key["references"]["table"] != table["name"]
            if pending and dialect != "sqlite":
                later.append(f"ALTER TABLE {table_name(dialect, table)} ADD {_foreign_key_sql(schema, dialect, key)}")
            else:
                parts.append(_foreign_key_sql(schema, dialect, key))
        body = ",\n  ".join(parts)
        statements.append(f"CREATE TABLE {table_name(dialect, table)} (\n  {body}\n)")
        for index in table["indexes"]:
            name = index.get("name") or f"ix_{table['name']}_{'_'.join(index['columns'])}"
            target = table_name(dialect, table)
            statements.append(f"CREATE INDEX {quote_name(dialect, name)} ON {target} ({columns(index['columns'])})")
        created.add(table["name"])
    return [*statements, *later]


def drop_statements(schema: dict, dialect: str) -> list[str]:
    """The statements that remove every table of the schema (and its types), so it can be created again."""
    tables = list(reversed(creation_order(schema)))
    if dialect in _MYSQL:
        return [
            "SET FOREIGN_KEY_CHECKS = 0",
            *(f"DROP TABLE IF EXISTS {table_name(dialect, table)}" for table in tables),
            "SET FOREIGN_KEY_CHECKS = 1",
        ]
    if dialect == "postgresql":
        return [
            *(f"DROP TABLE IF EXISTS {table_name(dialect, table)} CASCADE" for table in tables),
            *(
                f"DROP TYPE IF EXISTS {quote_name(dialect, item['name'])} CASCADE"
                for item in schema["enums"]
                if item["storage"] == "native"
            ),
        ]
    return [f"DROP TABLE IF EXISTS {table_name(dialect, table)}" for table in tables]
