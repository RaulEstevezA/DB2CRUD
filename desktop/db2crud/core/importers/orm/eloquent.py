"""Reads Eloquent (Laravel) into the physical schema. The columns are in the migrations, not in the models: each
`Schema::create`, `Schema::table`, `Schema::drop` and `Schema::rename` with its `Blueprint` (`$table->string('email',
120)->unique()`) is written as the DDL it stands for, the SQL of `DB::statement(…)` is taken as it is, and the whole, in
the order of the migrations, is read by the DDL reader. The models then give each table its class, the values of the
enums they cast to, and the names of their relations. The engine is the connection the configuration names
(`DB_CONNECTION`), or the one the SQL of the migrations shows. Mirrors web/src/core/importers/orm/eloquent.ts.

A step of a Blueprint chain is {name, args, named}; an operation of a migration has a kind: sql, create, table, drop
or rename."""

import re

from ...js import is_number, number_text
from ...model.naming import pluralize
from ...schema.checks import check_of
from ..code.lexer import Cursor, LexError, tokenize
from ..code.php import PHP_LEXER
from ..ddl.ddl import ddl_dialect, read_ddl
from .expressions import boolean_of, literal_of, name_of, number_of, read_arguments, read_expression, string_of, text_of
from .php import NAMED, class_of, entries_of, read_classes
from .types import OrmReader

# Reading the migrations


def _snake(text: str) -> str:
    """Laravel's `Str::snake`: `OrderLine` → `order_line`."""
    return re.sub(r"([a-z\d])([A-Z])", r"\1_\2", text).lower()


def _read_blueprint(cursor: Cursor, source: str, variable: str) -> list[list[dict]]:
    """The statements of a migration's closure that start with its Blueprint: `$table->…->…;`."""
    chains: list[list[dict]] = []
    cursor.next()
    while not cursor.done and not cursor.is_("}"):
        if cursor.is_(variable) and cursor.is_("->", 1) and cursor.is_ident(2):
            cursor.next()
            steps: list[dict] = []
            while cursor.eat("->") and cursor.is_ident():
                name = cursor.next().value
                if not cursor.is_("("):
                    break
                cursor.next()
                args, named = read_arguments(cursor, source, NAMED, ")")
                steps.append({"name": name, "args": args, "named": named})
            if steps:
                chains.append(steps)
            cursor.skip_until([";"])
            cursor.eat(";")
        elif cursor.is_("{") or cursor.is_("("):
            cursor.skip_group()
        else:
            cursor.next()
    cursor.eat("}")
    return chains


_HEREDOC = re.compile(r"<<<[ \t]*(['\"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2\b")
_OPEN_TAG = re.compile(r"^\s*<\?php")
_PLACEHOLDER = re.compile(r"\x00(\d+)")


def _read_migration(text: str) -> list[dict]:
    """What a migration does, in order: SQL of its own, or a Schema call with its table and Blueprint."""
    # Heredocs and nowdocs (`<<<'SQL' … SQL`) become texts the lexer reads: their bodies are kept aside
    bodies: list[str] = []

    def keep(match: re.Match) -> str:
        bodies.append(match.group(3))
        return f"'\x00{len(bodies) - 1}'"

    prepared = _OPEN_TAG.sub(lambda match: " " * len(match.group(0)), text, count=1)
    prepared = _HEREDOC.sub(keep, prepared)

    def text_of_arg(expr: dict | None) -> str | None:
        value = string_of(expr)
        heredoc = _PLACEHOLDER.fullmatch(value) if value is not None else None
        return bodies[int(heredoc.group(1))] if heredoc else value

    try:
        tokens = tokenize(prepared, PHP_LEXER)
    except LexError:
        return []
    cursor = Cursor(tokens)

    def value_at(position: int) -> str | None:
        return tokens[position].value if 0 <= position < len(tokens) else None

    # Only what up() does: down() undoes it
    undo: list[tuple[int, int]] = []
    for index, token in enumerate(tokens):
        if token.value != "function" or value_at(index + 1) != "down":
            continue
        cursor.index = index + 2
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        start = cursor.index
        cursor.skip_group()
        undo.append((start, cursor.index))
    operations: list[dict] = []
    index = 0
    while index < len(tokens):
        current = index
        index += 1
        if any(start <= current < end for start, end in undo):
            continue
        owner = tokens[current].value
        if owner not in ("Schema", "DB") or value_at(current + 1) != "::" or value_at(current + 3) != "(":
            continue
        method = tokens[current + 2].value
        cursor.index = current + 4
        if owner == "DB":
            if method not in ("statement", "unprepared"):
                continue
            args = read_arguments(cursor, prepared, NAMED, ")")[0]
            sql = text_of_arg(args[0] if args else None)
            if sql:
                operations.append({"kind": "sql", "sql": sql})
            continue
        if method in ("create", "table"):
            table = text_of_arg(read_expression(cursor, prepared, NAMED))
            if not table or not cursor.eat(","):
                continue
            # function (Blueprint $table) { … } or fn (Blueprint $table) => …
            if not cursor.is_("function") and not cursor.is_("fn"):
                continue
            cursor.next()
            parameters = cursor.index
            cursor.skip_group()
            variable = next(
                (
                    token.value
                    for token in tokens[parameters : cursor.index]
                    if token.kind == "ident" and token.value.startswith("$")
                ),
                None,
            )
            if cursor.is_("use"):
                cursor.next()
                cursor.skip_group()
            while not cursor.done and not cursor.is_("{") and not cursor.is_(")"):
                cursor.next()
            if not variable or not cursor.is_("{"):
                continue
            operations.append({"kind": method, "table": table, "chains": _read_blueprint(cursor, prepared, variable)})
            index = cursor.index
        elif method in ("drop", "dropIfExists"):
            args = read_arguments(cursor, prepared, NAMED, ")")[0]
            table = text_of_arg(args[0] if args else None)
            if table:
                operations.append({"kind": "drop", "table": table})
        elif method == "rename":
            args = [text_of_arg(arg) for arg in read_arguments(cursor, prepared, NAMED, ")")[0]]
            if len(args) > 1 and args[0] and args[1]:
                operations.append({"kind": "rename", "from": args[0], "to": args[1]})
    return operations


# From the Blueprint to DDL


def _quote_name(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _quote_text(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _names(columns: list[str]) -> str:
    return ", ".join(_quote_name(column) for column in columns)


def _columns_of(expr: dict | None) -> list[str]:
    """The columns an index call names: `'email'` or `['a', 'b']`."""
    if expr is not None and expr["kind"] == "list":
        return [value for value in (string_of(item) for item in expr["items"]) if value is not None]
    one = string_of(expr)
    return [one] if one is not None else []


def _index_name(table: str, columns: list[str], kind: str) -> str:
    """Laravel's name of an index: `<table>_<columns>_<kind>`."""
    return re.sub(r"[-.]", "_", f"{table}_{'_'.join(columns)}_{kind}".lower())


def _sql_value(expr: dict) -> str | None:
    """A PHP value as SQL: `'draft'`, `0`, `TRUE`, `NULL`, or `DB::raw('…')` as it is."""
    if expr["kind"] == "call" and name_of(expr) in ("raw", "Expression"):
        return string_of(expr["args"][0]) if expr["args"] else None
    if expr["kind"] == "name" and len(expr["path"]) == 1 and expr["path"][0].lower() == "null":
        return "NULL"
    value = literal_of(expr)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, str):
        return _quote_text(value)
    if is_number(value):
        return number_text(value)
    return None


_ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET NULL",
    "null": "SET NULL",
    "restrict": "RESTRICT",
    "no action": "NO ACTION",
    "noaction": "NO ACTION",
    "set default": "SET DEFAULT",
}

_SIMPLE_TYPES = {
    "bigInteger": "BIGINT",
    "unsignedBigInteger": "BIGINT",
    "foreignId": "BIGINT",
    "foreignIdFor": "BIGINT",
    "integer": "INTEGER",
    "unsignedInteger": "INTEGER",
    "mediumInteger": "INTEGER",
    "unsignedMediumInteger": "INTEGER",
    "smallInteger": "SMALLINT",
    "unsignedSmallInteger": "SMALLINT",
    "tinyInteger": "SMALLINT",
    "unsignedTinyInteger": "SMALLINT",
    "boolean": "BOOLEAN",
    "text": "TEXT",
    "tinyText": "TEXT",
    "mediumText": "TEXT",
    "longText": "TEXT",
    "set": "TEXT",
    "double": "DOUBLE PRECISION",
    "date": "DATE",
    "dateTime": "TIMESTAMP",
    "timestamp": "TIMESTAMP",
    "dateTimeTz": "TIMESTAMPTZ",
    "timestampTz": "TIMESTAMPTZ",
    "time": "TIME",
    "timeTz": "TIMETZ",
    "year": "YEAR",
    "uuid": "UUID",
    "foreignUuid": "UUID",
    "ulid": "CHAR(26)",
    "foreignUlid": "CHAR(26)",
    "json": "JSON",
    "jsonb": "JSONB",
    "binary": "BLOB",
    "ipAddress": "VARCHAR(45)",
    "macAddress": "VARCHAR(17)",
}

_IDENTITY_TYPES = {
    "id": "BIGINT",
    "bigIncrements": "BIGINT",
    "increments": "INTEGER",
    "mediumIncrements": "INTEGER",
    "smallIncrements": "SMALLINT",
    "tinyIncrements": "SMALLINT",
}


def _column_type(step: dict, dialect: str | None) -> dict | None:
    """The SQL type of a Blueprint column method, with what it adds: an identity key, the values of an enum."""
    args = step["args"]

    def number(position: int, fallback: int):
        found = number_of(args[position]) if len(args) > position else None
        return found if found is not None else fallback

    name = step["name"]
    if name in _IDENTITY_TYPES:
        return {"sql": _IDENTITY_TYPES[name], "identity": True}
    if name in _SIMPLE_TYPES:
        return {"sql": _SIMPLE_TYPES[name]}
    if name == "string":
        return {"sql": f"VARCHAR({number_text(number(1, 255))})"}
    if name == "char":
        return {"sql": f"CHAR({number_text(number(1, 255))})"}
    if name in ("decimal", "unsignedDecimal"):
        return {"sql": f"DECIMAL({number_text(number(1, 8))}, {number_text(number(2, 2))})"}
    if name == "float":
        return {"sql": "DOUBLE PRECISION" if number(1, 53) > 24 else "REAL"}
    if name == "enum":
        values = _columns_of(args[1] if len(args) > 1 else None)
        # MySQL keeps an enum as a type of the column; PostgreSQL and SQLite as text with a CHECK
        if dialect in ("postgresql", "sqlite"):
            return {"sql": "VARCHAR(255)", "values": values}
        return {"sql": f"ENUM({', '.join(_quote_text(value) for value in values)})"}
    return None


def _shorthand(step: dict) -> list[dict] | None:
    """The columns a method adds on its own: `timestamps()`, `softDeletes()`, `rememberToken()`, `morphs('owner')`."""
    name = string_of(step["args"][0]) if step["args"] else None
    method = step["name"]
    if method in ("timestamps", "nullableTimestamps"):
        return [{"name": column, "sql": "TIMESTAMP", "nullable": True} for column in ("created_at", "updated_at")]
    if method == "timestampsTz":
        return [{"name": column, "sql": "TIMESTAMPTZ", "nullable": True} for column in ("created_at", "updated_at")]
    if method == "softDeletes":
        return [{"name": name or "deleted_at", "sql": "TIMESTAMP", "nullable": True}]
    if method == "softDeletesTz":
        return [{"name": name or "deleted_at", "sql": "TIMESTAMPTZ", "nullable": True}]
    if method == "rememberToken":
        return [{"name": "remember_token", "sql": "VARCHAR(100)", "nullable": True}]
    if method in ("morphs", "nullableMorphs", "uuidMorphs", "nullableUuidMorphs"):
        if not name:
            return None
        optional = method.startswith("nullable")
        return [
            {"name": f"{name}_type", "sql": "VARCHAR(255)", "nullable": optional},
            {"name": f"{name}_id", "sql": "UUID" if "Uuid" in method else "BIGINT", "nullable": optional},
        ]
    return None


_DELETE = re.compile(r"OnDelete$|^onDelete$")
_UPDATE = re.compile(r"OnUpdate$|^onUpdate$")


def _blueprint_sql(operation: dict, dialect: str | None, table_of) -> list[str]:
    """The DDL of one Schema::create or Schema::table."""
    table = operation["table"]
    columns: list[str] = []
    constraints: list[str] = []
    after: list[str] = []
    alter = operation["kind"] == "table"

    def add(definition: str, changed: bool = False) -> None:
        if alter:
            after.append(
                f"ALTER TABLE {_quote_name(table)} {'MODIFY COLUMN' if changed else 'ADD COLUMN'} {definition}"
            )
        else:
            columns.append(definition)

    def constraint(definition: str) -> None:
        if alter:
            after.append(f"ALTER TABLE {_quote_name(table)} ADD {definition}")
        else:
            constraints.append(definition)

    def index(column_list: list[str], given: str | None) -> None:
        name = given if given is not None else _index_name(table, column_list, "index")
        after.append(f"CREATE INDEX {_quote_name(name)} ON {_quote_name(table)} ({_names(column_list)})")

    def drop(name: str) -> None:
        after.append(f"ALTER TABLE {_quote_name(table)} DROP CONSTRAINT {_quote_name(name)}")

    def foreign(column_list: list[str], steps: list[dict], given: str | None, target: dict | None = None) -> None:
        references = next((step for step in steps if step["name"] == "references"), None)
        on = next((step for step in steps if step["name"] == "on"), None)
        parent = target["table"] if target else (string_of(on["args"][0]) if on and on["args"] else None)
        if not parent:
            return
        if target:
            referenced = [target["column"]]
        else:
            referenced = _columns_of(references["args"][0] if references and references["args"] else None)
        name = given if given is not None else _index_name(table, column_list, "foreign")
        sql = (
            f"CONSTRAINT {_quote_name(name)} FOREIGN KEY ({_names(column_list)}) REFERENCES {_quote_name(parent)} "
            f"({_names(referenced or ['id'])})"
        )
        for step in steps:
            if _DELETE.search(step["name"]):
                which = "DELETE"
            elif _UPDATE.search(step["name"]):
                which = "UPDATE"
            else:
                continue
            if step["name"] in ("onDelete", "onUpdate"):
                given_action = string_of(step["args"][0]) if step["args"] else None
                action = _ACTIONS.get((given_action or "").lower())
            else:
                action = _ACTIONS.get(re.sub(r"On(Delete|Update)$", "", step["name"]).lower())
            if action:
                sql += f" ON {which} {action}"
        constraint(sql)

    for chain in operation["chains"]:
        first, modifiers = chain[0], chain[1:]
        first_args = first["args"]
        name = string_of(first_args[0]) if first_args else None
        method = first["name"]
        # Constraints of the table: primary(['a', 'b']), unique('email'), index([...]), foreign('user_id')->…
        if method in ("primary", "unique", "index", "foreign"):
            column_list = _columns_of(first_args[0] if first_args else None)
            given = string_of(first_args[1]) if len(first_args) > 1 else None
            if not column_list:
                continue
            if method == "primary":
                key = given if given is not None else _index_name(table, column_list, "primary")
                constraint(f"CONSTRAINT {_quote_name(key)} PRIMARY KEY ({_names(column_list)})")
            elif method == "unique":
                key = given if given is not None else _index_name(table, column_list, "unique")
                constraint(f"CONSTRAINT {_quote_name(key)} UNIQUE ({_names(column_list)})")
            elif method == "index":
                index(column_list, given)
            else:
                foreign(column_list, modifiers, given)
            continue
        if method == "dropColumn":
            for column in [item for arg in first_args for item in _columns_of(arg)]:
                after.append(f"ALTER TABLE {_quote_name(table)} DROP COLUMN {_quote_name(column)}")
            continue
        if method in ("dropTimestamps", "dropTimestampsTz"):
            for column in ("created_at", "updated_at"):
                after.append(f"ALTER TABLE {_quote_name(table)} DROP COLUMN {_quote_name(column)}")
            continue
        if method in ("dropSoftDeletes", "dropSoftDeletesTz"):
            after.append(f"ALTER TABLE {_quote_name(table)} DROP COLUMN {_quote_name(name or 'deleted_at')}")
            continue
        if method in ("dropUnique", "dropForeign", "dropPrimary"):
            kind = method[4:].lower()
            column_list = _columns_of(first_args[0]) if first_args and first_args[0]["kind"] == "list" else []
            if column_list:
                drop(_index_name(table, column_list, kind))
            else:
                drop(name if name is not None else _index_name(table, [], kind))
            continue
        if method == "comment":
            continue
        many = _shorthand(first)
        if many is not None:
            for column in many:
                add(f"{_quote_name(column['name'])} {column['sql']} {'NULL' if column['nullable'] else 'NOT NULL'}")
            if method.endswith("orphs") and name:
                index([f"{name}_type", f"{name}_id"], None)
            continue
        column_type = _column_type(first, dialect)
        # id() is named `id`; foreignIdFor(User::class) `user_id`
        model = class_of(first_args[0]) if method == "foreignIdFor" and first_args else None
        if method == "id":
            column = name or "id"
        elif model:
            given_column = string_of(first_args[1]) if len(first_args) > 1 else None
            column = given_column if given_column is not None else f"{_snake(model)}_id"
        else:
            column = name
        if column_type is None or not column:
            continue

        def has(wanted: str, modifiers: list[dict] = modifiers) -> dict | None:
            return next((step for step in modifiers if step["name"] == wanted), None)

        nullable_step = has("nullable")
        nullable = (
            boolean_of(nullable_step["args"][0] if nullable_step["args"] else None) is not False
            if nullable_step
            else False
        )
        definition = f"{_quote_name(column)} {column_type['sql']} {'NULL' if nullable else 'NOT NULL'}"
        default_step = has("default")
        value = _sql_value(default_step["args"][0]) if default_step and default_step["args"] else None
        if value is not None:
            definition += f" DEFAULT {value}"
        if has("useCurrent"):
            definition += " DEFAULT CURRENT_TIMESTAMP"
        if has("useCurrentOnUpdate"):
            definition += " ON UPDATE CURRENT_TIMESTAMP"
        stored = has("storedAs") or has("virtualAs")
        expression = None
        if stored and stored["args"]:
            expression = string_of(stored["args"][0])
            if expression is None:
                expression = text_of(stored["args"][0])
        if expression:
            definition += (
                f" GENERATED ALWAYS AS ({expression}) {'STORED' if stored['name'] == 'storedAs' else 'VIRTUAL'}"
            )
        if column_type.get("identity") or has("autoIncrement") or has("generatedAs"):
            definition += " GENERATED BY DEFAULT AS IDENTITY"
        if column_type.get("identity") or has("primary"):
            definition += " PRIMARY KEY"
        comment_step = has("comment")
        comment = string_of(comment_step["args"][0]) if comment_step and comment_step["args"] else None
        if comment:
            definition += f" COMMENT {_quote_text(comment)}"
        if column_type.get("values") is not None:
            values = ", ".join(_quote_text(item) for item in column_type["values"])
            definition += f" CHECK ({_quote_name(column)} IN ({values}))"
        add(definition, bool(has("change")))
        unique = has("unique")
        if unique:
            given_unique = string_of(unique["args"][0]) if unique["args"] else None
            key = given_unique if given_unique is not None else _index_name(table, [column], "unique")
            constraint(f"CONSTRAINT {_quote_name(key)} UNIQUE ({_quote_name(column)})")
        indexed = has("index")
        if indexed:
            index([column], string_of(indexed["args"][0]) if indexed["args"] else None)
        # foreignId('user_id')->constrained() points to users.id; foreignIdFor(User::class) to the model's table
        constrained = has("constrained")
        if constrained:
            given_parent = string_of(constrained["args"][0]) if constrained["args"] else None
            if given_parent is None:
                given_parent = table_of(model) if model else pluralize(re.sub(r"_id$", "", column))
            given_column = string_of(constrained["args"][1]) if len(constrained["args"]) > 1 else None
            foreign(
                [column],
                modifiers,
                string_of(constrained["named"].get("indexName")),
                {"table": given_parent, "column": given_column if given_column is not None else "id"},
            )
        elif has("references"):
            foreign([column], modifiers, None)
    if operation["kind"] == "create":
        comment = next(
            (chain for chain in operation["chains"] if chain[0]["name"] == "comment" and len(chain) == 1), None
        )
        options = ""
        if comment is not None:
            text = string_of(comment[0]["args"][0]) if comment[0]["args"] else None
            options = f" COMMENT={_quote_text(text or '')}"
        body = ",\n  ".join([*columns, *constraints])
        return [f"CREATE TABLE {_quote_name(table)} (\n  {body}\n){options}", *after]
    return after


# The connection

_CONNECTIONS = {
    "pgsql": "postgresql",
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "sqlite": "sqlite",
    "sqlsrv": "sqlserver",
}

_ENV = re.compile(r"^\s*DB_CONNECTION\s*=\s*['\"]?(\w+)", re.MULTILINE)
_CONFIG = re.compile(r"['\"]default['\"]\s*=>\s*env\(\s*['\"]DB_CONNECTION['\"]\s*,\s*['\"](\w+)['\"]")


def _connection_of(files: list[dict]) -> str | None:
    """The engine the configuration names: `DB_CONNECTION=pgsql`, or the default of config/database.php."""
    for file in files:
        match = _ENV.search(file["text"]) or _CONFIG.search(file["text"])
        if match and match.group(1) in _CONNECTIONS:
            return _CONNECTIONS[match.group(1)]
    return None


# The models

_MODEL_BASES = {"Model", "Authenticatable", "Pivot", "MorphPivot"}
_DECLARES = re.compile(r"\b(class|enum)\s+\w+")
_MIGRATES = re.compile(r"\bSchema::|\bDB::(statement|unprepared)\b")


def _quoted(values: list) -> str:
    return ", ".join(
        number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'" for value in values
    )


def _read_eloquent(files: list[dict]) -> dict:
    notes: list[dict] = []
    classes = read_classes([file for file in files if _DECLARES.search(file["text"])])
    by_name = {cls["name"]: cls for cls in classes}

    def is_model(cls: dict, seen: set | None = None) -> bool:
        seen = seen if seen is not None else set()
        seen.add(cls["name"])
        if not cls["base"]:
            return False
        if cls["base"] in _MODEL_BASES:
            return True
        base = by_name.get(cls["base"])
        return base is not None and base["name"] not in seen and is_model(base, seen)

    models = [cls for cls in classes if cls["kind"] == "class" and is_model(cls)]

    def prop(cls: dict, name: str) -> dict | None:
        return next((item.get("initializer") for item in cls["properties"] if item["name"] == name), None)

    def table_of(model: str) -> str:
        cls = by_name.get(model)
        given = string_of(prop(cls, "table")) if cls is not None else None
        return given if given is not None else _snake(pluralize(model))

    # The migrations, in the order of their names, as one DDL text
    migrations = sorted((file for file in files if _MIGRATES.search(file["text"])), key=lambda file: file["name"])
    operations = [operation for file in migrations for operation in _read_migration(file["text"])]
    raw_sql = [operation["sql"] for operation in operations if operation["kind"] == "sql"]
    dialect = _connection_of(files)
    if dialect is None and raw_sql:
        dialect = ddl_dialect(";\n".join(raw_sql))
    statements: list[str] = []
    for operation in operations:
        if operation["kind"] == "sql":
            statements.append(operation["sql"])
        elif operation["kind"] == "drop":
            statements.append(f"DROP TABLE IF EXISTS {_quote_name(operation['table'])}")
        elif operation["kind"] == "rename":
            statements.append(f"ALTER TABLE {_quote_name(operation['from'])} RENAME TO {_quote_name(operation['to'])}")
        else:
            statements.extend(_blueprint_sql(operation, dialect, table_of))
    schema = read_ddl(";\n".join(statements), dialect)
    notes.extend(schema["notes"])

    for model in models:
        table_name = table_of(model["name"])
        table = next((item for item in schema["tables"] if item["name"] == table_name), None)
        if table is None:
            notes.append({"code": "orm.modelWithoutTable", "params": {"table": table_name}})
            continue
        table["entity"] = model["name"]
        # Casts to an enum: the values it keeps, checked
        casts = prop(model, "casts")
        if casts is None:
            method = next((item for item in model["methods"] if item["name"] == "casts"), None)
            casts = next((item for item in method["returns"] if item["kind"] == "dict"), None) if method else None
        for column, cast in entries_of(casts).items():
            enum_class = by_name.get(class_of(cast) or "")
            target = next((item for item in table["columns"] if item["name"] == column), None)
            # A column that is already an enum of the database needs no CHECK
            if enum_class is None or enum_class["kind"] != "enum" or target is None or target["type"]["kind"] == "enum":
                continue
            values = [item["value"] if "value" in item else item["name"] for item in enum_class["cases"]]
            enum_name = _snake(enum_class["name"])
            if not any(item["name"] == enum_name for item in schema["enums"]):
                schema["enums"].append(
                    {
                        "name": enum_name,
                        "values": [value if isinstance(value, str) else number_text(value) for value in values],
                        "storage": "check",
                    }
                )
            declared = any(
                (check.get("parsed") or {}).get("kind") == "in" and check["parsed"]["column"] == column
                for check in table["checks"]
            )
            if not declared:
                table["checks"].append(check_of(f"{column} IN ({_quoted(values)})"))
        # Relations name the foreign keys: belongsTo on this side, hasMany and hasOne on the other
        for method in model["methods"]:
            relation = next((item for item in method["returns"] if item["kind"] == "call"), None)
            if relation is None:
                continue
            kind = name_of(relation)
            args = relation["args"]
            related = class_of(args[0]) if args else None
            if not related or not kind:
                continue
            if kind == "belongsTo":
                given = string_of(args[1]) if len(args) > 1 else None
                owner = string_of(args[2]) if len(args) > 2 else None
                column = (
                    given if given is not None else f"{_snake(method['name'])}_{owner if owner is not None else 'id'}"
                )
                key = next((item for item in table["foreignKeys"] if item["columns"] == [column]), None)
                if key is not None and not key.get("attribute"):
                    key["attribute"] = method["name"]
            elif kind in ("hasMany", "hasOne"):
                other = next((item for item in schema["tables"] if item["name"] == table_of(related)), None)
                given = string_of(args[1]) if len(args) > 1 else None
                column = given if given is not None else f"{_snake(model['name'])}_id"
                key = (
                    next(
                        (
                            item
                            for item in other["foreignKeys"]
                            if item["columns"] == [column] and item["references"]["table"] == table["name"]
                        ),
                        None,
                    )
                    if other is not None
                    else None
                )
                if key is not None and not key.get("inverse"):
                    key["inverse"] = method["name"]
    return {**schema, "source": {"kind": "orm", "format": "eloquent"}, "notes": notes}


_ILLUMINATE = re.compile(r"\bIlluminate\\(Database|Support\\Facades)\b")
_LARAVEL = re.compile(r"\bSchema::(create|table)\b|\bextends\s+(Model|Authenticatable|Pivot)\b")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _ILLUMINATE.search(text) and _LARAVEL.search(text) else 0


ELOQUENT_READER = OrmReader(id="eloquent", label="Eloquent", language="php", detect=_detect, read=_read_eloquent)
