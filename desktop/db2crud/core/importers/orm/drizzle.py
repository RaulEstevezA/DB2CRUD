"""Reads Drizzle schemas into the physical schema: tables declared with `pgTable`, `mysqlTable` or `sqliteTable`
(also `pgSchema(…).table`), their columns as chains of calls (`bigint('id').primaryKey().notNull()`), the
constraints the third argument returns (`index`, `uniqueIndex`, `unique`, `primaryKey`, `foreignKey`, `check`), enums
(`pgEnum`, `mysqlEnum`, the `enum` option of a text column), column types of `customType`, and the navigation names
of `relations`. The table function names the engine. Mirrors web/src/core/importers/orm/drizzle.ts.

A table call is {variable, dialect, schema, args, line}; a model {call, table, columns}."""

import re

from ...schema.checks import check_of
from ..code.lexer import Cursor, LexError, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .expressions import boolean_of, chain_of, literal_of, name_of, number_of, read_expression, string_of, text_of
from .types import OrmReader
from .typescript import NAMED

# Reading the calls


def _read_call_arguments(cursor: Cursor, source: str) -> list[dict]:
    """The arguments of a call after its `(`, with the body of an arrow function in place of the function:
    `(t) => [index('ix').on(t.a)]` is read as the list. A function with a block body is kept as text."""
    args: list[dict] = []
    while not cursor.done and not cursor.is_(")"):
        start = cursor.index
        arrow = False
        if cursor.is_("("):
            cursor.skip_group()
            # `(t): Constraints => …`
            if cursor.is_(":"):
                while not cursor.done and not cursor.is_("=>") and not cursor.is_(",") and not cursor.is_(")"):
                    cursor.next()
            arrow = cursor.is_("=>")
        elif cursor.is_ident() and cursor.is_("=>", 1):
            cursor.next()
            arrow = True
        if arrow:
            cursor.next()
            if cursor.is_("{"):
                body = cursor.index
                cursor.skip_group()
                args.append({"kind": "other", "text": cursor.text_between(source, body, cursor.index)})
            else:
                args.append(read_expression(cursor, source, NAMED))
        else:
            cursor.index = start
            args.append(read_expression(cursor, source, NAMED))
        if not cursor.eat(","):
            break
    cursor.eat(")")
    return args


_TABLES = {"pgTable": "postgresql", "mysqlTable": "mysql", "sqliteTable": "sqlite"}
_SCHEMAS = {"pgSchema": "postgresql", "mysqlSchema": "mysql"}
_ENUMS = {"pgEnum": "postgresql"}

_CUSTOM_TYPE = re.compile(
    r"\bconst\s+([\w$]+)\s*=\s*customType\b[\s\S]*?dataType\s*(?::\s*\([^)]*\)\s*=>\s*|\([^)]*\)\s*\{\s*return\s+)"
    r"[`'\"]([^`'\"]+)[`'\"]",
    re.ASCII,
)


def _strings(items: list) -> list[str]:
    return [value for value in (string_of(item) for item in items) if value is not None]


def _read_calls(files: list[dict]) -> tuple[list, list, dict, dict]:
    tables: list[dict] = []
    relations: list[dict] = []
    enums: dict[str, dict] = {}
    custom_types: dict[str, str] = {}
    schemas: dict[str, dict] = {}
    for file in files:
        for match in _CUSTOM_TYPE.finditer(file["text"]):
            custom_types[match.group(1)] = match.group(2)
        try:
            tokens = tokenize(file["text"], TYPESCRIPT_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)

        def arguments_at(index: int, cursor: Cursor = cursor, source: str = file["text"]) -> list:
            cursor.index = index
            return _read_call_arguments(cursor, source)

        def at(position: int, tokens: list = tokens):
            return tokens[position] if 0 <= position < len(tokens) else None

        def value_at(position: int) -> str | None:
            token = at(position)
            return token.value if token is not None else None

        def variable_before(index: int) -> str | None:
            before = at(index - 2)
            return (
                before.value if value_at(index - 1) == "=" and before is not None and before.kind == "ident" else None
            )

        for index, token in enumerate(tokens):
            if token.kind != "ident":
                continue
            if value_at(index + 1) == "(" and value_at(index - 1) != ".":
                if token.value in _TABLES:
                    tables.append(
                        {
                            "variable": variable_before(index),
                            "dialect": _TABLES[token.value],
                            "schema": None,
                            "args": arguments_at(index + 2),
                            "line": token.line,
                        }
                    )
                elif token.value in _SCHEMAS:
                    variable = variable_before(index)
                    args = arguments_at(index + 2)
                    name = string_of(args[0]) if args else None
                    if variable and name:
                        schemas[variable] = {"name": name, "dialect": _SCHEMAS[token.value]}
                elif token.value in _ENUMS:
                    variable = variable_before(index)
                    args = arguments_at(index + 2)
                    name = string_of(args[0]) if args else None
                    values = args[1] if len(args) > 1 else None
                    if variable and name and values is not None and values["kind"] == "list":
                        enums[variable] = {"name": name, "values": _strings(values["items"])}
                elif token.value == "relations":
                    args = arguments_at(index + 2)
                    variable = name_of(args[0]) if args else None
                    if variable:
                        relations.append({"variable": variable, "body": args[1] if len(args) > 1 else None})
            elif value_at(index + 1) == "." and value_at(index + 2) == "table" and value_at(index + 3) == "(":
                schema = schemas.get(token.value)
                if schema is not None:
                    tables.append(
                        {
                            "variable": variable_before(index),
                            "dialect": schema["dialect"],
                            "schema": schema["name"],
                            "args": arguments_at(index + 4),
                            "line": token.line,
                        }
                    )
    return tables, relations, enums, custom_types


# Types


def _entries_of(expr: dict | None) -> dict:
    """The entries of an object literal, by key."""
    entries: dict = {}
    if expr is not None and expr["kind"] == "dict":
        for entry in expr["entries"]:
            key = name_of(entry["key"])
            key = key if key is not None else string_of(entry["key"])
            if key:
                entries[key] = entry["value"]
    return entries


_SQL_TYPE = re.compile(r"([a-z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?", re.IGNORECASE)


def _sql_type_of(text: str, dialect: str) -> dict | None:
    """The database type of a type written in SQL (`datetime`, `varchar(20)`), for the columns of a `customType`."""
    sql = text.strip()
    match = _SQL_TYPE.fullmatch(sql)
    if not match:
        return None
    name = match.group(1).lower()
    size = int(match.group(2)) if match.group(2) is not None else None
    scale = int(match.group(3)) if match.group(3) is not None else None
    if name in ("smallint", "int2", "tinyint"):
        return {"sql": sql, "kind": "integer", "bits": 16}
    if name in ("int", "integer", "int4", "mediumint"):
        return {"sql": sql, "kind": "integer", "bits": 64 if dialect == "sqlite" else 32}
    if name in ("bigint", "int8"):
        return {"sql": sql, "kind": "integer", "bits": 64}
    if name in ("real", "float4", "float"):
        return {"sql": sql, "kind": "float", "bits": 64 if dialect == "sqlite" else 32}
    if name in ("double", "double precision", "float8"):
        return {"sql": sql, "kind": "float", "bits": 64}
    if name in ("decimal", "numeric"):
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": size} if size is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if name in ("varchar", "character varying", "nvarchar"):
        return {"sql": sql, "kind": "text", "length": size} if size is not None else {"sql": sql, "kind": "text"}
    if name in ("char", "character", "nchar"):
        if size is not None:
            return {"sql": sql, "kind": "text", "length": size, "fixed": True}
        return {"sql": sql, "kind": "text", "fixed": True}
    if name in ("text", "tinytext", "mediumtext", "longtext", "citext", "clob"):
        return {"sql": sql, "kind": "text"}
    if name in ("boolean", "bool"):
        return {"sql": sql, "kind": "boolean"}
    if name == "date":
        return {"sql": sql, "kind": "date"}
    if name in ("time", "time without time zone"):
        return {"sql": sql, "kind": "time", "timezone": False}
    if name in ("timetz", "time with time zone"):
        return {"sql": sql, "kind": "time", "timezone": True}
    if name in ("datetime", "timestamp", "timestamp without time zone"):
        return {"sql": sql, "kind": "datetime", "timezone": False}
    if name in ("timestamptz", "timestamp with time zone"):
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if name in ("uuid", "uniqueidentifier"):
        return {"sql": sql, "kind": "uuid"}
    if name in ("json", "jsonb"):
        return {"sql": sql, "kind": "json"}
    if name in ("bytea", "blob", "binary", "varbinary", "longblob"):
        return {"sql": sql, "kind": "binary", "length": size} if size is not None else {"sql": sql, "kind": "binary"}
    return None


def _type_of(builder: dict, dialect: str, enums: dict, custom_types: dict) -> dict | None:
    """The type a column builder declares: `varchar('name', { length: 120 })`. The result is {type, identity?,
    values?, enumName?}."""
    name = name_of(builder["callee"]) or ""
    options = _entries_of(next((arg for arg in builder["args"] if arg["kind"] == "dict"), None))
    sql = text_of(builder)
    length = number_of(options.get("length"))
    mode = string_of(options.get("mode"))
    enum_option = options.get("enum")
    values = _strings(enum_option["items"]) if enum_option is not None and enum_option["kind"] == "list" else None

    def text(fixed: bool = False) -> dict:
        return {
            "type": {
                "sql": sql,
                "kind": "text",
                **({"length": length} if length is not None else {}),
                **({"fixed": fixed} if fixed else {}),
            },
            **({"values": values} if values is not None else {}),
        }

    enum_call = enums.get(name)
    if enum_call is not None:
        return {"type": {"sql": sql, "kind": "enum", "name": enum_call["name"]}, "enumName": enum_call["name"]}
    if name == "mysqlEnum":
        listed = next((arg for arg in builder["args"] if arg["kind"] == "list"), None)
        items = _strings(listed["items"]) if listed is not None else []
        return {"type": {"sql": sql, "kind": "text"}, "values": items, "enumName": ""}
    custom = custom_types.get(name)
    if custom is not None:
        found = _sql_type_of(custom, dialect)
        return {"type": {**found, "sql": custom}} if found else None
    if name in ("smallint", "int2", "tinyint"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 16}}
    if name in ("integer", "int"):
        if dialect == "sqlite" and mode in ("timestamp", "timestamp_ms"):
            return {"type": {"sql": sql, "kind": "datetime", "timezone": False}}
        if dialect == "sqlite" and mode == "boolean":
            return {"type": {"sql": sql, "kind": "boolean"}}
        return {"type": {"sql": sql, "kind": "integer", "bits": 64 if dialect == "sqlite" else 32}}
    if name in ("int4", "mediumint"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 32}}
    if name in ("bigint", "int8"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 64}}
    if name in ("serial", "serial4"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 64 if dialect == "mysql" else 32}, "identity": True}
    if name in ("smallserial", "serial2"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 16}, "identity": True}
    if name in ("bigserial", "serial8"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 64}, "identity": True}
    if name == "real":
        return {"type": {"sql": sql, "kind": "float", "bits": 32 if dialect == "postgresql" else 64}}
    if name == "float":
        return {"type": {"sql": sql, "kind": "float", "bits": 32}}
    if name in ("doublePrecision", "double"):
        return {"type": {"sql": sql, "kind": "float", "bits": 64}}
    if name in ("numeric", "decimal"):
        precision = number_of(options.get("precision"))
        scale = number_of(options.get("scale"))
        return {
            "type": {
                "sql": sql,
                "kind": "decimal",
                **({"precision": precision} if precision is not None else {}),
                **({"scale": scale} if scale is not None else {}),
            }
        }
    if name == "text":
        if dialect == "sqlite" and mode == "json":
            return {"type": {"sql": sql, "kind": "json"}}
        return text()
    if name in ("tinytext", "mediumtext", "longtext", "varchar"):
        return text()
    if name == "char":
        return text(True)
    if name == "boolean":
        return {"type": {"sql": sql, "kind": "boolean"}}
    if name == "date":
        return {"type": {"sql": sql, "kind": "date"}}
    if name == "time":
        return {"type": {"sql": sql, "kind": "time", "timezone": boolean_of(options.get("withTimezone")) is True}}
    if name == "timestamp":
        return {"type": {"sql": sql, "kind": "datetime", "timezone": boolean_of(options.get("withTimezone")) is True}}
    if name == "datetime":
        return {"type": {"sql": sql, "kind": "datetime", "timezone": False}}
    if name == "uuid":
        return {"type": {"sql": sql, "kind": "uuid"}}
    if name in ("json", "jsonb"):
        return {"type": {"sql": sql, "kind": "json"}}
    if name == "blob":
        return {"type": {"sql": sql, "kind": "json" if mode == "json" else "binary"}}
    if name in ("binary", "varbinary", "bytea"):
        return {"type": {"sql": sql, "kind": "binary", **({"length": length} if length is not None else {})}}
    return None


_NOW_SQL = re.compile(
    r"now\(\)|current_timestamp(\(\d*\))?|localtimestamp|\(?datetime\('now'\)\)?|\(?unixepoch\(\)\)?", re.IGNORECASE
)
_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)", re.IGNORECASE)
_INTERPOLATION = re.compile(r"\$\{\s*[\w$]+\s*\.\s*([\w$]+)\s*\}", re.ASCII)


def _sql_of(expr: dict | None, column_of) -> str | None:
    """The SQL of `sql\\`…\\`` or `sql.raw('…')`, with `${table.column}` written as the column."""
    if expr is None or expr["kind"] != "call":
        return None
    callee = expr["callee"]
    is_sql = (callee["kind"] == "name" and callee["path"][0] == "sql") or (
        callee["kind"] == "attribute" and name_of(callee["target"]) == "sql"
    )
    if not is_sql:
        return None
    text = string_of(expr["args"][0]) if expr["args"] else None
    return _INTERPOLATION.sub(lambda match: column_of(match.group(1)), text) if text is not None else None


_ACTIONS = {
    "cascade": "cascade",
    "set null": "set null",
    "set default": "set default",
    "restrict": "restrict",
    "no action": "no action",
}


def _action_of(expr: dict | None) -> str | None:
    return _ACTIONS.get((string_of(expr) or "").lower())


def _property_of(expr: dict) -> str | None:
    """`table.column` (or `t.column`): the property it names."""
    return expr["path"][1] if expr["kind"] == "name" and len(expr["path"]) == 2 else None


def _calls_of(expr: dict) -> list[dict]:
    return [item for item in chain_of(expr) if item["kind"] == "call"]


_REFERENCE = re.compile(r"=>\s*([\w$]+)\s*\.\s*([\w$]+)\s*$", re.ASCII)


def _quoted(values: list[str]) -> str:
    return ", ".join("'" + value.replace("'", "''") + "'" for value in values)


# Building the tables


def _read_drizzle(files: list[dict]) -> dict:
    notes: list[dict] = []
    calls, relations, enums, custom_types = _read_calls(files)
    dialects = {call["dialect"] for call in calls}
    dialect = next(iter(dialects)) if len(dialects) == 1 else None
    db_enums: list[dict] = []

    def add_enum(name: str, values: list[str], storage: str) -> None:
        if not any(item["name"] == name for item in db_enums):
            db_enums.append({"name": name, "values": values, "storage": storage})

    models: list[dict] = []
    by_variable: dict[str, dict] = {}
    # References name another table's column: resolved once every table is read
    references: list[dict] = []
    for call in calls:
        table_name = string_of(call["args"][0]) if call["args"] else None
        if not table_name:
            continue
        table = {
            "name": table_name,
            "columns": [],
            "primaryKey": None,
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            **({"entity": call["variable"]} if call["variable"] else {}),
            "origin": {"line": call["line"], "column": 1},
        }
        if call["schema"]:
            table["schema"] = call["schema"]
        model = {"call": call, "table": table, "columns": {}}
        primary: list[str] = []
        columns_arg = call["args"][1] if len(call["args"]) > 1 else None
        for entry in columns_arg["entries"] if columns_arg is not None and columns_arg["kind"] == "dict" else []:
            prop = name_of(entry["key"])
            prop = prop if prop is not None else string_of(entry["key"])
            if not prop:
                continue
            chain = _calls_of(entry["value"])
            if not chain:
                continue
            builder = chain[0]
            given = string_of(builder["args"][0]) if builder["args"] else None
            name = given if given is not None else prop
            read = _type_of(builder, call["dialect"], enums, custom_types)
            column_type = read["type"] if read else None
            if read and read.get("enumName"):
                add_enum(read["enumName"], enums.get(name_of(builder["callee"]) or "", {}).get("values", []), "native")
            if read and "values" in read:
                # `mysqlEnum` is a type of the column; the `enum` option of a text column only types it in TypeScript
                if read.get("enumName") == "":
                    enum_name = f"{table_name}_{name}"
                    add_enum(enum_name, read["values"], "native")
                    column_type = {"sql": read["type"]["sql"], "kind": "enum", "name": enum_name}
                else:
                    add_enum(f"{table_name}_{name}", read["values"], "check")
                    table["checks"].append(check_of(f"{name} IN ({_quoted(read['values'])})"))
            if column_type is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {
                            "table": table_name,
                            "column": name,
                            "type": name_of(builder["callee"]) or text_of(builder),
                        },
                    }
                )
            column = {
                "name": name,
                "type": column_type if column_type is not None else {"sql": text_of(builder), "kind": "unknown"},
                "nullable": True,
            }
            if read and read.get("identity"):
                column["generated"] = "identity"

            def own_column(item: str, model: dict = model) -> str:
                return model["columns"].get(item, item)

            for modifier in chain[1:]:
                what = name_of(modifier["callee"])
                arg = modifier["args"][0] if modifier["args"] else None
                if what == "notNull":
                    column["nullable"] = False
                elif what == "primaryKey":
                    column["nullable"] = False
                    primary.append(name)
                    if boolean_of(_entries_of(arg).get("autoIncrement")) is True:
                        column["generated"] = "identity"
                elif what == "default" and arg is not None:
                    sql = _sql_of(arg, own_column)
                    if sql is not None:
                        if _NOW_SQL.fullmatch(sql.strip()):
                            column["generated"] = "now"
                        elif _UUID_SQL.fullmatch(sql.strip()):
                            column["generated"] = "uuid"
                        else:
                            column["default"] = {"kind": "expression", "sql": sql}
                    elif arg["kind"] == "name" and arg["path"] == ["null"]:
                        column["default"] = {"kind": "literal", "value": None}
                    else:
                        value = literal_of(arg)
                        if value is not None:
                            column["default"] = {"kind": "literal", "value": value}
                        else:
                            column["default"] = {"kind": "expression", "sql": text_of(arg)}
                elif what == "defaultNow":
                    column["generated"] = "now"
                elif what == "defaultRandom":
                    column["generated"] = "uuid"
                elif what == "onUpdateNow":
                    column["generated"] = "onUpdateNow"
                elif what in ("autoincrement", "generatedAlwaysAsIdentity", "generatedByDefaultAsIdentity"):
                    column["generated"] = "identity"
                elif what == "generatedAlwaysAs" and arg is not None:
                    sql = _sql_of(arg, own_column)
                    sql = sql if sql is not None else string_of(arg)
                    if sql:
                        column["generated"] = {"computed": sql}
                elif what == "array" and column["type"]["kind"] != "unknown":
                    column["type"] = {
                        "sql": f"{column['type']['sql']}.array()",
                        "kind": "array",
                        "items": column["type"],
                    }
                elif what == "unique":
                    unique_name = string_of(arg)
                    table["uniques"].append({**({"name": unique_name} if unique_name else {}), "columns": [name]})
                elif what == "references" and arg is not None and arg["kind"] == "other":
                    target = _REFERENCE.search(arg["text"])
                    if target:
                        references.append(
                            {
                                "model": model,
                                "column": name,
                                "target": target.group(1),
                                "property": target.group(2),
                                "options": _entries_of(modifier["args"][1] if len(modifier["args"]) > 1 else None),
                            }
                        )
            if name != prop:
                column["attribute"] = prop
            table["columns"].append(column)
            model["columns"][prop] = name
        if primary:
            table["primaryKey"] = primary
        # SQLite numbers an INTEGER PRIMARY KEY on its own (it is the rowid)
        if call["dialect"] == "sqlite" and len(primary) == 1:
            key = next(item for item in table["columns"] if item["name"] == primary[0])
            if key["type"]["kind"] == "integer" and not key.get("generated"):
                key["generated"] = "identity"
        models.append(model)
        if call["variable"]:
            by_variable[call["variable"]] = model

    def column_of(model: dict, expr: dict) -> str | None:
        prop = _property_of(expr)
        return model["columns"].get(prop, prop) if prop is not None else None

    def list_of(expr: dict | None) -> list:
        return expr["items"] if expr is not None and expr["kind"] == "list" else []

    def columns_in(model: dict, items: list) -> list[str]:
        return [column for column in (column_of(model, item) for item in items) if column is not None]

    for model in models:
        table = model["table"]
        call_args = model["call"]["args"]
        extra = call_args[2] if len(call_args) > 2 else None
        if extra is not None and extra["kind"] == "list":
            items = extra["items"]
        elif extra is not None and extra["kind"] == "dict":
            items = [entry["value"] for entry in extra["entries"]]
        else:
            items = []
        for item in items:
            chain = _calls_of(item)
            if not chain:
                continue
            head = chain[0]
            kind = name_of(head["callee"])
            on = next((part for part in chain if name_of(part["callee"]) == "on"), None)
            on_columns = columns_in(model, on["args"] if on is not None else [])
            name = string_of(head["args"][0]) if head["args"] else None
            named = {"name": name} if name else {}
            if kind == "index" and on_columns:
                table["indexes"].append({**named, "columns": on_columns})
            elif kind in ("uniqueIndex", "unique") and on_columns:
                table["uniques"].append({**named, "columns": on_columns})
            elif kind == "primaryKey":
                options = _entries_of(head["args"][0] if head["args"] else None)
                columns = list_of(options.get("columns")) if "columns" in options else head["args"]
                table["primaryKey"] = columns_in(model, columns)
                for column in table["columns"]:
                    if column["name"] in table["primaryKey"]:
                        column["nullable"] = False
            elif kind == "check":

                def own(prop: str, model: dict = model) -> str:
                    return model["columns"].get(prop, prop)

                sql = _sql_of(head["args"][1] if len(head["args"]) > 1 else None, own)
                if sql:
                    table["checks"].append(check_of(sql, name))
            elif kind == "foreignKey":
                options = _entries_of(head["args"][0] if head["args"] else None)
                foreign = list_of(options.get("foreignColumns"))
                target = by_variable.get(foreign[0]["path"][0]) if foreign and foreign[0]["kind"] == "name" else None
                if target is None:
                    continue
                key_name = string_of(options.get("name"))
                on_delete_call = next((part for part in chain if name_of(part["callee"]) == "onDelete"), None)
                on_update_call = next((part for part in chain if name_of(part["callee"]) == "onUpdate"), None)
                on_delete = _action_of(on_delete_call["args"][0] if on_delete_call and on_delete_call["args"] else None)
                on_update = _action_of(on_update_call["args"][0] if on_update_call and on_update_call["args"] else None)
                target_table = target["table"]
                table["foreignKeys"].append(
                    {
                        **({"name": key_name} if key_name else {}),
                        "columns": columns_in(model, list_of(options.get("columns"))),
                        "references": {
                            "table": target_table["name"],
                            **({"schema": target_table["schema"]} if target_table.get("schema") else {}),
                            "columns": columns_in(target, foreign),
                        },
                        **({"onDelete": on_delete} if on_delete else {}),
                        **({"onUpdate": on_update} if on_update else {}),
                    }
                )
    for reference in references:
        target = by_variable.get(reference["target"])
        if target is None:
            continue
        on_delete = _action_of(reference["options"].get("onDelete"))
        on_update = _action_of(reference["options"].get("onUpdate"))
        target_table = target["table"]
        reference["model"]["table"]["foreignKeys"].append(
            {
                "columns": [reference["column"]],
                "references": {
                    "table": target_table["name"],
                    **({"schema": target_table["schema"]} if target_table.get("schema") else {}),
                    "columns": [target["columns"].get(reference["property"], reference["property"])],
                },
                **({"onDelete": on_delete} if on_delete else {}),
                **({"onUpdate": on_update} if on_update else {}),
            }
        )
    _apply_relations(relations, by_variable, column_of)
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "drizzle"},
        "tables": [model["table"] for model in models],
        "enums": db_enums,
        "notes": notes,
    }


def _apply_relations(relations: list[dict], by_variable: dict, column_of) -> None:
    """The navigation names `relations` gives: `one(…, { fields })` names the foreign key of its fields, and
    `many(…)` with the same `relationName` (or the only one between the two tables) names the other side."""
    named: dict[str, dict] = {}
    many: list[dict] = []
    for relation in relations:
        model = by_variable.get(relation["variable"])
        body = relation["body"]
        if model is None or body is None or body["kind"] != "dict":
            continue
        for entry in body["entries"]:
            name = name_of(entry["key"])
            name = name if name is not None else string_of(entry["key"])
            value = entry["value"]
            if not name or value["kind"] != "call":
                continue
            target = by_variable.get((name_of(value["args"][0]) if value["args"] else None) or "")
            if target is None:
                continue
            options = _entries_of(value["args"][1] if len(value["args"]) > 1 else None)
            relation_name = string_of(options.get("relationName"))
            if name_of(value["callee"]) == "many":
                many.append({"model": model, "target": target, "name": name, "relationName": relation_name})
                continue
            fields = options.get("fields")
            columns = [
                column_of(model, item) for item in (fields["items"] if fields and fields["kind"] == "list" else [])
            ]
            key = next(
                (
                    item
                    for item in model["table"]["foreignKeys"]
                    if item["references"]["table"] == target["table"]["name"] and item["columns"] == columns
                ),
                None,
            )
            if key is None:
                continue
            key["attribute"] = name
            if relation_name:
                named[relation_name] = key
    for item in many:
        candidates = [
            key
            for key in item["target"]["table"]["foreignKeys"]
            if key["references"]["table"] == item["model"]["table"]["name"]
        ]
        if item["relationName"]:
            key = named.get(item["relationName"])
        else:
            key = candidates[0] if len(candidates) == 1 else None
        if key is not None and any(candidate is key for candidate in candidates):
            key["inverse"] = item["name"]


_CORE = re.compile(r"['\"]drizzle-orm/(pg|mysql|sqlite)-core['\"]")
_TABLE_CALL = re.compile(r"\b(pgTable|mysqlTable|sqliteTable|\.table)\s*\(")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _CORE.search(text) and _TABLE_CALL.search(text) else 0


DRIZZLE_READER = OrmReader(id="drizzle", label="Drizzle", language="typescript", detect=_detect, read=_read_drizzle)
