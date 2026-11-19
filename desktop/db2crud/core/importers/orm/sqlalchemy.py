"""Reads SQLAlchemy models into the physical schema: declarative classes (`__tablename__`, `mapped_column` or
`Column`, typed `Mapped[...]` or not, `__table_args__`), association tables (`Table(...)`), indexes declared after
the classes, Python enums and relationships. It reads the code Model2DB writes and the usual hand-written forms;
anything else goes to the notes. The code says nothing about the engine: the dialect stays unknown. Mirrors
web/src/core/importers/orm/sqlalchemy.ts."""

import re

from ...js import coalesce, is_number, js_string, number, number_text, trim
from ...model.naming import to_snake_case
from ...schema.checks import check_of
from ..code.lexer import Cursor, tokenize
from ..code.python import PYTHON_LEXER
from .expressions import (
    boolean_of,
    chain_of,
    literal_of,
    name_of,
    number_of,
    read_expression,
    string_of,
    text_of,
)
from .types import OrmReader

# Splitting a module into statements


def _statements_of(tokens: list, source: str) -> list[dict]:
    """The statements of a block: a new one starts on a line at the block's indentation, outside any bracket."""
    if not tokens:
        return []
    indent = tokens[0].column
    statements: list[dict] = []
    current: list = []
    depth = 0
    for token in tokens:
        if token.line_start and depth == 0 and token.column <= indent and current:
            statements.append({"tokens": current, "source": source})
            current = []
        current.append(token)
        if token.kind == "punct":
            if token.value in ("(", "[", "{"):
                depth += 1
            elif token.value in (")", "]", "}"):
                depth = max(0, depth - 1)
    if current:
        statements.append({"tokens": current, "source": source})
    return statements


def _class_of(statement: dict) -> dict | None:
    """`class Name(Base, Mixin):` and the statements of its body."""
    cursor = Cursor(statement["tokens"])
    if not cursor.is_("class") or not cursor.is_ident(1):
        return None
    cursor.next()
    name = cursor.next().value
    bases: list[str] = []
    if cursor.eat("("):
        while not cursor.done and not cursor.is_(")"):
            text = text_of(read_expression(cursor, statement["source"]))
            if text:
                bases.append(text)
            if not cursor.eat(","):
                break
        cursor.eat(")")
    cursor.eat(":")
    return {
        "name": name,
        "bases": bases,
        "body": _statements_of(statement["tokens"][cursor.index :], statement["source"]),
        "line": statement["tokens"][0].line,
    }


def _assignment_of(statement: dict) -> dict | None:
    """`name: Annotation = value` or `name = value`: the parts of an assignment."""
    cursor = Cursor(statement["tokens"])
    if not cursor.is_ident():
        return None
    name = cursor.next().value
    annotation = ""
    if cursor.eat(":"):
        start = cursor.index
        cursor.skip_until(["="])
        annotation = cursor.text_between(statement["source"], start, cursor.index)
    if not cursor.eat("="):
        return {"name": name, "annotation": annotation, "value": None} if annotation else None
    return {"name": name, "annotation": annotation, "value": read_expression(cursor, statement["source"])}


# Types


def _text_type(sql: str, kind: str, length, fixed: bool = False) -> dict:
    return {
        "sql": sql,
        "kind": kind,
        **({"length": length} if length is not None else {}),
        **({"fixed": True} if fixed else {}),
    }


def _type_of(expr: dict, enums: dict, column: str) -> dict | None:
    """The SQLAlchemy type of a column, as a database type, or None when it is not one the rules know."""
    # with_variant and the like change the type for one engine: the type is the first of the chain
    base = chain_of(expr)[0]
    sql = text_of(expr)
    name = (name_of(base) or "").upper()
    args = base["args"] if base["kind"] == "call" else []
    named = base["named"] if base["kind"] == "call" else {}
    first = args[0] if args else None
    length = coalesce(number_of(first), number_of(named.get("length")))
    if name in ("SMALLINTEGER", "SMALLINT"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 16}}
    if name in ("INTEGER", "INT"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 32}}
    if name in ("BIGINTEGER", "BIGINT"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 64}}
    if name in ("NUMERIC", "DECIMAL"):
        precision = coalesce(number_of(first), number_of(named.get("precision")))
        scale = coalesce(number_of(args[1] if len(args) > 1 else None), number_of(named.get("scale")))
        return {
            "type": {
                "sql": sql,
                "kind": "decimal",
                **({"precision": precision} if precision is not None else {}),
                **({"scale": scale} if scale is not None else {}),
            }
        }
    if name in ("FLOAT", "REAL"):
        return {"type": {"sql": sql, "kind": "float", "bits": 32}}
    if name in ("DOUBLE", "DOUBLE_PRECISION"):
        return {"type": {"sql": sql, "kind": "float", "bits": 64}}
    if name in ("STRING", "VARCHAR", "UNICODE", "NVARCHAR"):
        return {"type": _text_type(sql, "text", length)}
    if name in ("CHAR", "NCHAR"):
        return {"type": _text_type(sql, "text", length, True)}
    if name in ("TEXT", "UNICODETEXT", "CLOB"):
        return {"type": {"sql": sql, "kind": "text"}}
    if name == "BOOLEAN":
        return {"type": {"sql": sql, "kind": "boolean"}}
    if name == "DATE":
        return {"type": {"sql": sql, "kind": "date"}}
    if name == "TIME":
        return {"type": {"sql": sql, "kind": "time", "timezone": boolean_of(named.get("timezone")) is True}}
    if name in ("DATETIME", "TIMESTAMP"):
        timezone = named["timezone"] if "timezone" in named else first
        return {"type": {"sql": sql, "kind": "datetime", "timezone": boolean_of(timezone) is True}}
    if name in ("UUID", "UUIDTYPE"):
        return {"type": {"sql": sql, "kind": "uuid"}}
    if name in ("LARGEBINARY", "BLOB", "BINARY", "VARBINARY", "BYTEA"):
        return {"type": _text_type(sql, "binary", length)}
    if name in ("JSON", "JSONB"):
        return {"type": {"sql": sql, "kind": "json"}}
    if name == "ARRAY":
        items = _type_of(first, enums, column) if first is not None else None
        return {
            "type": {"sql": sql, "kind": "array", "items": items["type"] if items else {"sql": "", "kind": "unknown"}}
        }
    if name == "ENUM":
        return _enum_type_of(base, sql, enums, column)
    return None


def _enum_type_of(expr: dict, sql: str, enums: dict, column: str) -> dict:
    """How a column uses an enum: {name, values, native, check, checkName?}. A CHECK keeps the values when
    SQLAlchemy writes one (a non-native enum with create_constraint)."""
    args = expr["args"] if expr["kind"] == "call" else []
    named = expr["named"] if expr["kind"] == "call" else {}
    enum_class = enums.get(args[0]["path"][-1]) if args and args[0]["kind"] == "name" else None
    # values_callable stores the values of the members; without it SQLAlchemy stores their names
    by_value = "values_callable" in named
    if enum_class:
        values = [member["value"] if by_value else member["name"] for member in enum_class["members"]]
    else:
        values = [value for value in map(literal_of, args) if value is not None and not isinstance(value, bool)]
    native = boolean_of(named.get("native_enum")) is not False
    declared = string_of(named.get("name"))
    name = to_snake_case(enum_class["name"]) if enum_class else coalesce(declared, f"{column}_enum")
    use = {
        "name": coalesce(declared, enum_class["name"].lower() if enum_class else None, name) if native else name,
        "values": values,
        "native": native,
        "check": not native and boolean_of(named.get("create_constraint")) is True,
        **({"checkName": declared} if not native and declared else {}),
    }
    if native:
        return {"type": {"sql": sql, "kind": "enum", "name": use["name"]}, "enum": use}
    return {"type": _text_type(sql, "text", number_of(named.get("length"))), "enum": use}


_SIMPLE = {
    "int": {"sql": "Integer", "kind": "integer", "bits": 32},
    "str": {"sql": "String", "kind": "text"},
    "float": {"sql": "Float", "kind": "float", "bits": 64},
    "bool": {"sql": "Boolean", "kind": "boolean"},
    "bytes": {"sql": "LargeBinary", "kind": "binary"},
    "datetime.datetime": {"sql": "DateTime", "kind": "datetime", "timezone": False},
    "datetime": {"sql": "DateTime", "kind": "datetime", "timezone": False},
    "datetime.date": {"sql": "Date", "kind": "date"},
    "date": {"sql": "Date", "kind": "date"},
    "datetime.time": {"sql": "Time", "kind": "time", "timezone": False},
    "decimal.Decimal": {"sql": "Numeric", "kind": "decimal"},
    "Decimal": {"sql": "Numeric", "kind": "decimal"},
    "uuid.UUID": {"sql": "Uuid", "kind": "uuid"},
    "UUID": {"sql": "Uuid", "kind": "uuid"},
}


def _type_of_annotation(annotation: str, enums: dict, column: str) -> dict | None:
    """The database type of a column typed only by its Python annotation, as SQLAlchemy maps it."""
    match = re.search(r"Mapped\[(.*)\]", annotation, re.S)
    inner = match.group(1) if match else annotation
    python = trim(re.sub(r"\|\s*None|None\s*\|", "", re.sub(r"Optional\[(.*)\]", r"\1", inner, count=1, flags=re.S)))
    if python in _SIMPLE:
        return {"type": dict(_SIMPLE[python])}
    enum_class = enums.get(python.split(".")[-1])
    if enum_class:
        call = {
            "kind": "call",
            "callee": {"kind": "name", "path": ["Enum"]},
            "args": [{"kind": "name", "path": [enum_class["name"]]}],
            "named": {},
        }
        return _enum_type_of(call, f"Enum({enum_class['name']})", enums, column)
    return None


def _nullable_by_annotation(annotation: str) -> bool:
    return re.search(r"\bNone\b|\bOptional\[", annotation) is not None


# Reading the module


def _reference_of(expr: dict | None) -> dict | None:
    """What a reference to a column says before every class is known: `"customers.id"` or `Customer.id`."""
    text = string_of(expr)
    if text is not None:
        parts = text.split(".")
        if len(parts) < 2:
            return None
        column = parts.pop()
        table = parts.pop()
        return {"table": table, **({"schema": ".".join(parts)} if parts else {}), "column": column}
    if expr is not None and expr["kind"] == "name" and len(expr["path"]) >= 2:
        return {"className": expr["path"][-2], "column": expr["path"][-1]}
    return None


_ACTIONS = {
    "CASCADE": "cascade",
    "SET NULL": "set null",
    "SET DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO ACTION": "no action",
}


def _action_of(expr: dict | None) -> str | None:
    text = string_of(expr)
    return _ACTIONS.get(text.upper()) if text else None


def _pending_key(name: str | None, columns: list[str], named: dict, targets: list[dict]) -> dict:
    """A key waiting for its target to be known: {key, targets, untyped?}."""
    on_delete = _action_of(named.get("ondelete"))
    on_update = _action_of(named.get("onupdate"))
    return {
        "key": {
            **({"name": name} if name else {}),
            "columns": columns,
            "references": {"table": "", "columns": []},
            **({"onDelete": on_delete} if on_delete else {}),
            **({"onUpdate": on_update} if on_update else {}),
        },
        "targets": targets,
    }


def _foreign_key_of(expr: dict, column: str) -> dict | None:
    """`ForeignKey("customers.id", ondelete="CASCADE")`, as a key waiting for its target to be known."""
    if expr["kind"] != "call":
        return None
    target = _reference_of(expr["args"][0] if expr["args"] else None)
    if not target:
        return None
    return _pending_key(string_of(expr["named"].get("name")), [column], expr["named"], [target])


_NOW = ("now", "current_timestamp", "utcnow", "localtimestamp", "current_date", "today")


def _is_now(expr: dict | None) -> bool:
    return expr is not None and (name_of(expr) or "").lower() in _NOW


def _is_uuid(expr: dict | None) -> bool:
    return (
        expr is not None
        and re.fullmatch(r"uuid[147]|uuid_generate_v4|gen_random_uuid", name_of(expr) or "") is not None
    )


def _server_default(expr: dict, column: dict) -> None:
    """A default the database applies. A text is a value SQLAlchemy quotes (`server_default="0"`); `text("…")` is SQL
    as written; `func.now()` and `true()` are what they say."""
    is_call = expr["kind"] == "call"
    sql = string_of(expr["args"][0] if expr["args"] else None) if is_call and name_of(expr) == "text" else None
    call = (name_of(expr) or "").lower() if is_call and not expr["args"] else None
    if _is_now(expr) or (
        sql is not None and re.fullmatch(r"now\(\)|current_timestamp(\(\))?|localtimestamp(\(\))?", trim(sql), re.I)
    ):
        column["generated"] = "now"
        return
    if _is_uuid(expr) or (
        sql is not None and re.fullmatch(r"(gen_random_uuid|uuid_generate_v4|uuid)\(\)", trim(sql), re.I)
    ):
        column["generated"] = "uuid"
        return
    if call in ("true", "false"):
        column["default"] = {"kind": "literal", "value": call == "true"}
        return
    value = string_of(expr)
    if value is not None:
        column["default"] = {"kind": "literal", "value": _literal_for(value, column["type"])}
        return
    if sql is None:
        column["default"] = {"kind": "expression", "sql": text_of(expr)}
        return
    text = trim(sql)
    quoted = re.fullmatch(r"'((?:[^']|'')*)'", text, re.S)
    if quoted:
        column["default"] = {"kind": "literal", "value": quoted.group(1).replace("''", "'")}
    elif re.fullmatch(r"-?\d+(\.\d+)?", text):
        column["default"] = {"kind": "literal", "value": number(text)}
    elif re.fullmatch(r"true|false", text, re.I):
        column["default"] = {"kind": "literal", "value": text.lower() == "true"}
    else:
        column["default"] = {"kind": "expression", "sql": text}


def _literal_for(value: str, column_type: dict):
    """A quoted default as the value of the column's type: `"0"` is the number 0 for a number column."""
    if column_type["kind"] in ("integer", "decimal", "float") and re.fullmatch(r"-?\d+(\.\d+)?", value):
        return number(value)
    if column_type["kind"] == "boolean" and re.fullmatch(r"true|false|1|0", value, re.I):
        return re.fullmatch(r"true|1", value, re.I) is not None
    return value


def _column_of(
    call: dict, attribute: str, annotation: str, classic: bool, enums: dict, notes: list, table: str
) -> dict:
    """A column from the arguments of `mapped_column(...)` or `Column(...)`: {column, primaryKey, autoincrement (None:
    not said), identity, unique, index, key, typeFromKey (no type is written: SQLAlchemy takes the one of the column
    the key references), enum?}."""
    name = attribute
    type_expr = None
    key = None
    identity = False
    computed = None
    args = list(call["args"])
    named = call["named"]
    if args and string_of(args[0]) is not None:
        name = string_of(args.pop(0))
    for arg in args:
        callee = name_of(arg)
        if callee == "ForeignKey":
            key = _foreign_key_of(arg, name)
        elif callee == "Identity":
            identity = True
        elif callee == "Computed" and arg["kind"] == "call":
            computed = string_of(arg["args"][0] if arg["args"] else None)
        elif callee == "Sequence":
            identity = True
        elif type_expr is None:
            type_expr = arg
    if "type_" in named:
        type_expr = named["type_"]
    read = _type_of(type_expr, enums, name) if type_expr is not None else _type_of_annotation(annotation, enums, name)
    type_from_key = not read and type_expr is None and key is not None
    if not read and not type_from_key:
        notes.append(
            {
                "code": "orm.unknownType",
                "params": {
                    "table": table,
                    "column": name,
                    "type": text_of(type_expr) if type_expr is not None else annotation,
                },
            }
        )
    primary_key = boolean_of(named.get("primary_key")) is True
    nullable_said = boolean_of(named.get("nullable"))
    # A typed attribute takes null when its annotation does; a classic Column does unless it is the key
    if nullable_said is not None:
        nullable = nullable_said
    elif primary_key:
        nullable = False
    else:
        nullable = True if classic and not annotation else _nullable_by_annotation(annotation)
    column_type = (
        read["type"]
        if read
        else {"sql": text_of(type_expr) if type_expr is not None else annotation, "kind": "unknown"}
    )
    column: dict = {"name": name, "type": column_type, "nullable": nullable}
    if computed is not None:
        column["generated"] = {"computed": computed}
    if "server_default" in named:
        _server_default(named["server_default"], column)
    use = read.get("enum") if read else None
    value = named.get("default")
    if value is not None and not column.get("generated"):
        if _is_uuid(value):
            column["generated"] = "uuid"
        elif _is_now(value):
            column["generated"] = "now"
        else:
            literal = literal_of(value)
            if literal is not None:
                column["default"] = {"kind": "literal", "value": coalesce(_enum_literal(value, use, enums), literal)}
            elif value["kind"] in ("attribute", "name"):
                member = _enum_literal(value, use, enums)
                if member is not None:
                    column["default"] = {"kind": "literal", "value": member}
    if "onupdate" in named and _is_now(named["onupdate"]):
        column["generated"] = "onUpdateNow"
    comment = string_of(named.get("comment"))
    if comment:
        column["comment"] = comment
    if name != attribute:
        column["attribute"] = attribute
    autoincrement = boolean_of(named.get("autoincrement"))
    return {
        "column": column,
        "primaryKey": primary_key,
        "autoincrement": autoincrement,
        "identity": identity,
        "unique": boolean_of(named.get("unique")) is True,
        "index": boolean_of(named.get("index")) is True,
        "key": key,
        "typeFromKey": type_from_key,
        **({"enum": use} if use else {}),
    }


def _enum_literal(expr: dict, use: dict | None, enums: dict):
    """`OrderStatus.PAID` as the value the database keeps for it."""
    if not use or expr["kind"] != "name" or len(expr["path"]) < 2:
        return None
    enum_class = enums.get(expr["path"][-2])
    member = (
        next((item for item in enum_class["members"] if item["name"] == expr["path"][-1]), None) if enum_class else None
    )
    if not member:
        return None
    return member["value"] if member["value"] in use["values"] else member["name"]


def _table_arguments(items: list[dict], mapped: dict, attribute_column) -> None:
    """The table arguments: constraints, indexes and the `{"schema": …}` dictionary."""
    table = mapped["table"]

    def names(args: list[dict]) -> list[str]:
        result = []
        for arg in args:
            name = coalesce(string_of(arg), attribute_column(arg["path"][-1]) if arg["kind"] == "name" else None)
            if name:
                result.append(name)
        return result

    for item in items:
        if item["kind"] == "dict":
            for entry in item["entries"]:
                key = string_of(entry["key"])
                if key == "schema" and string_of(entry["value"]):
                    table["schema"] = string_of(entry["value"])
                if key == "comment" and string_of(entry["value"]):
                    table["comment"] = string_of(entry["value"])
            continue
        if item["kind"] != "call":
            continue
        args = item["args"]
        name = string_of(item["named"].get("name"))
        callee = name_of(item)
        if callee == "UniqueConstraint":
            table["uniques"].append({**({"name": name} if name else {}), "columns": names(args)})
        elif callee == "PrimaryKeyConstraint":
            table["primaryKey"] = names(args)
        elif callee == "CheckConstraint":
            sql = string_of(args[0] if args else None)
            if sql:
                table["checks"].append(check_of(sql, name))
        elif callee == "Index":
            index_name = string_of(args[0] if args else None)
            index = {**({"name": index_name} if index_name else {}), "columns": names(args[1:])}
            if boolean_of(item["named"].get("unique")):
                table["uniques"].append(index)
            else:
                table["indexes"].append(index)
        elif callee == "ForeignKeyConstraint":
            columns = names(args[0]["items"]) if args and args[0]["kind"] == "list" else []
            targets = (
                [ref for ref in map(_reference_of, args[1]["items"]) if ref is not None]
                if len(args) > 1 and args[1]["kind"] == "list"
                else []
            )
            mapped["keys"].append(_pending_key(name, columns, item["named"], targets))


def _empty_table(name: str, line: int) -> dict:
    return {
        "name": name,
        "columns": [],
        "primaryKey": None,
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": line, "column": 1},
    }


def _mapped(table: dict, class_name: str | None = None) -> dict:
    """A table with what is needed to resolve it: the attribute name of each column, the keys waiting for their target
    and the navigations of its class."""
    return {"table": table, "className": class_name, "attributes": {}, "keys": [], "navigations": []}


def _add_column(mapped: dict, read: dict, attribute: str, enums_used: list) -> None:
    """Adds a column and what its arguments say about the table."""
    table = mapped["table"]
    column = read["column"]
    table["columns"].append(column)
    mapped["attributes"][attribute] = column["name"]
    if read["unique"]:
        table["uniques"].append({"columns": [column["name"]]})
    if read["index"]:
        table["indexes"].append({"columns": [column["name"]]})
    if read["key"]:
        mapped["keys"].append({**read["key"], "untyped": [column]} if read["typeFromKey"] else read["key"])
    use = read.get("enum")
    if use:
        enums_used.append(use)
        if use["check"]:
            values = [
                number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'"
                for value in use["values"]
            ]
            table["checks"].append(check_of(f"{column['name']} IN ({', '.join(values)})", use.get("checkName")))


def _finish_key(table: dict, reads: list[dict]) -> None:
    """The key and the identity of a table, once its columns are read."""
    key_columns = [read["column"]["name"] for read in reads if read["primaryKey"]]
    if table["primaryKey"] is None and key_columns:
        table["primaryKey"] = key_columns
    for read in reads:
        column = read["column"]
        if column.get("generated"):
            continue
        primary_key = table["primaryKey"]
        single = primary_key is not None and len(primary_key) == 1 and primary_key[0] == column["name"]
        # SQLAlchemy numbers a key of one integer column unless autoincrement=False
        numbered = (
            read["identity"]
            or read["autoincrement"] is True
            or (single and read["autoincrement"] is None and column["type"]["kind"] == "integer")
        )
        if numbered:
            column["generated"] = "identity"


_MAPPED_COLUMN = {"kind": "call", "callee": {"kind": "name", "path": ["mapped_column"]}, "args": [], "named": {}}


def _class_table(definition: dict, enums: dict, notes: list, enums_used: list) -> dict | None:
    assignments = [_assignment_of(statement) for statement in definition["body"]]
    tablename = next((item for item in assignments if item and item["name"] == "__tablename__"), None)
    name = string_of(tablename["value"] if tablename else None)
    if not name:
        return None
    mapped = _mapped(_empty_table(name, definition["line"]), definition["name"])
    mapped["table"]["entity"] = definition["name"]
    reads: list[dict] = []
    table_args = None
    for item in assignments:
        if not item or item["name"].startswith("__"):
            if item and item["name"] == "__table_args__":
                table_args = item["value"]
            continue
        # `published_at: Mapped[datetime | None]` is a column with nothing more than its annotation
        value = item["value"]
        if value is None:
            value = _MAPPED_COLUMN if re.match(r"\s*Mapped\[", item["annotation"]) else {"kind": "other", "text": ""}
        callee = name_of(value)
        if value["kind"] == "call" and callee in ("mapped_column", "Column"):
            read = _column_of(value, item["name"], item["annotation"], callee == "Column", enums, notes, name)
            reads.append(read)
            _add_column(mapped, read, item["name"], enums_used)
        elif value["kind"] == "call" and callee == "relationship" and "secondary" not in value["named"]:
            foreign_keys = value["named"].get("foreign_keys")
            navigation = {"name": item["name"], "target": _target_of_relationship(item["annotation"], value)}
            if foreign_keys is not None:
                navigation["foreignKeys"] = coalesce(
                    string_of(foreign_keys),
                    text_of(foreign_keys["items"][0]) if foreign_keys["kind"] == "list" else text_of(foreign_keys),
                )
            mapped["navigations"].append(navigation)
    if table_args is not None:
        _table_arguments(
            table_args["items"] if table_args["kind"] == "list" else [table_args],
            mapped,
            lambda attribute: mapped["attributes"].get(attribute, attribute),
        )
    _finish_key(mapped["table"], reads)
    return mapped


def _target_of_relationship(annotation: str, call: dict) -> str:
    """The class a relationship goes to: the first argument, or the type of its annotation."""
    first = call["args"][0] if call["args"] else None
    named = coalesce(string_of(first), first["path"][-1] if first is not None and first["kind"] == "name" else None)
    if named:
        return named
    match = re.search(r"Mapped\[(.*)\]", annotation, re.S)
    inner = re.sub(r"\b(Optional|list|List|set|Set)\[|[\"'\]]|\|\s*None", "", match.group(1) if match else "")
    found = re.search(r"[A-Za-z_][A-Za-z0-9_]*", inner)
    return found.group(0) if found else ""


def _module_table(call: dict, line: int, enums: dict, notes: list, enums_used: list) -> dict | None:
    """`Table("order_tags", Base.metadata, Column(...), ...)`: an association table, with no class of its own."""
    name = string_of(call["args"][0] if call["args"] else None)
    if not name:
        return None
    mapped = _mapped(_empty_table(name, line))
    schema = string_of(call["named"].get("schema"))
    if schema:
        mapped["table"]["schema"] = schema
    reads: list[dict] = []
    constraints: list[dict] = []
    for arg in call["args"][1:]:
        if arg["kind"] == "call" and name_of(arg) == "Column":
            column_name = coalesce(string_of(arg["args"][0] if arg["args"] else None), "")
            read = _column_of(arg, column_name, "", True, enums, notes, name)
            reads.append(read)
            _add_column(mapped, read, column_name, enums_used)
        else:
            constraints.append(arg)
    _table_arguments(constraints, mapped, lambda attribute: attribute)
    _finish_key(mapped["table"], reads)
    return mapped


def _enum_class_of(definition: dict) -> dict | None:
    """`class OrderStatus(enum.Enum):` and its members, {name, value} in order."""
    if not any(re.search(r"(^|\.)(Enum|IntEnum|StrEnum)\Z", base) for base in definition["bases"]):
        return None
    members = []
    for statement in definition["body"]:
        item = _assignment_of(statement)
        value = literal_of(item["value"]) if item else None
        if item and not item["name"].startswith("_") and (isinstance(value, str) or is_number(value)):
            members.append({"name": item["name"], "value": value})
    return {"name": definition["name"], "members": members}


# Resolving what refers to what


def _resolve(tables: list[dict], notes: list) -> None:
    by_class = {mapped["className"]: mapped for mapped in tables if mapped["className"]}

    def column_of_class(class_name: str, attribute: str | None) -> str | None:
        mapped = by_class.get(class_name)
        return mapped["attributes"].get(attribute) if mapped else None

    for mapped in tables:
        for pending in mapped["keys"]:
            targets = pending["targets"]
            first = targets[0] if targets else None
            target = None
            if first and first.get("className"):
                found = by_class.get(first["className"])
                target = found["table"] if found else None
            elif first and first.get("table"):
                target = next(
                    (
                        item["table"]
                        for item in tables
                        if item["table"]["name"] == first["table"]
                        and (not first.get("schema") or item["table"].get("schema") == first["schema"])
                    ),
                    None,
                )
            key = pending["key"]
            if not first or not target:
                notes.append(
                    {
                        "code": "orm.unknownReference",
                        "params": {"table": mapped["table"]["name"], "column": ", ".join(key["columns"])},
                    }
                )
                continue
            key["references"] = {
                "table": target["name"],
                **({"schema": target["schema"]} if target.get("schema") else {}),
                "columns": [
                    coalesce(column_of_class(ref["className"], ref["column"]), ref["column"])
                    if ref.get("className")
                    else ref["column"]
                    for ref in targets
                ],
            }
            mapped["table"]["foreignKeys"].append(key)
            for index, column in enumerate(pending.get("untyped") or []):
                referenced_name = (
                    key["references"]["columns"][index] if index < len(key["references"]["columns"]) else None
                )
                referenced = next((item for item in target["columns"] if item["name"] == referenced_name), None)
                if referenced:
                    column["type"] = referenced["type"]
                else:
                    notes.append(
                        {
                            "code": "orm.unknownType",
                            "params": {"table": mapped["table"]["name"], "column": column["name"], "type": ""},
                        }
                    )
    # Navigation names: the attribute of the class that holds the key, and the list on the other side
    for mapped in tables:
        for navigation in mapped["navigations"]:
            target = by_class.get(navigation["target"])
            if not target:
                continue
            # The side that holds the key reads one row of the other; the other side reads the rows that point at it
            parts = (navigation.get("foreignKeys") or "").split(".")
            class_name = parts[0]
            attribute = parts[1] if len(parts) > 1 else None
            column = column_of_class(class_name, attribute) if class_name else None

            def points_at(source: dict, destination: dict, column=column) -> dict | None:
                return next(
                    (
                        item
                        for item in source["table"]["foreignKeys"]
                        if item["references"]["table"] == destination["table"]["name"]
                        and item["references"].get("schema") == destination["table"].get("schema")
                        and (not column or item["columns"][0] == column)
                    ),
                    None,
                )

            own = points_at(mapped, target) if not class_name or class_name == mapped["className"] else None
            if own:
                if not own.get("attribute"):
                    own["attribute"] = navigation["name"]
                continue
            other = points_at(target, mapped)
            if other and not other.get("inverse"):
                other["inverse"] = navigation["name"]


def _module_index(call: dict, tables: list[dict]) -> None:
    """`Index("ix_orders_customer_id_created_at", Order.customer_id, Order.created_at.desc(), unique=True)` after the
    classes."""
    columns: list[str] = []
    owner = None
    for arg in call["args"][1:]:
        reference = chain_of(arg)[0] if arg["kind"] == "call" else arg
        if reference["kind"] == "attribute" and reference["target"]["kind"] == "name":
            path = [*reference["target"]["path"], reference["name"]]
        elif reference["kind"] == "name":
            path = reference["path"]
        else:
            path = None
        if not path or len(path) < 2:
            continue
        if owner is None:
            owner = next((item for item in tables if item["className"] == path[-2]), None)
        columns.append(coalesce(owner["attributes"].get(path[-1]) if owner else None, path[-1]))
    if not owner:
        return
    name = string_of(call["args"][0] if call["args"] else None)
    index = {**({"name": name} if name else {}), "columns": columns}
    if boolean_of(call["named"].get("unique")):
        owner["table"]["uniques"].append(index)
    else:
        owner["table"]["indexes"].append(index)


def _read_sqlalchemy(files: list[dict]) -> dict:
    notes: list = []
    enums: dict = {}
    modules = [_statements_of(tokenize(file["text"], PYTHON_LEXER), file["text"]) for file in files]
    # Enums first: a column may name one declared further down
    classes: list[dict] = []
    for statements in modules:
        for statement in statements:
            definition = _class_of(statement)
            if not definition:
                continue
            enum_class = _enum_class_of(definition)
            if enum_class:
                enums[enum_class["name"]] = enum_class
            else:
                classes.append(definition)
    tables: list[dict] = []
    enums_used: list[dict] = []
    for definition in classes:
        mapped = _class_table(definition, enums, notes, enums_used)
        if mapped:
            tables.append(mapped)
    indexes: list[dict] = []
    for statements in modules:
        for statement in statements:
            first = statement["tokens"][0] if statement["tokens"] else None
            if first is not None and first.value == "class":
                continue
            assignment = _assignment_of(statement)
            value = assignment["value"] if assignment else None
            if value is None:
                value = read_expression(Cursor(statement["tokens"]), statement["source"])
            if value["kind"] != "call":
                continue
            if name_of(value) == "Table":
                mapped = _module_table(value, statement["tokens"][0].line, enums, notes, enums_used)
                if mapped:
                    tables.append(mapped)
            elif name_of(value) == "Index":
                indexes.append(value)
    _resolve(tables, notes)
    for call in indexes:
        _module_index(call, tables)
    enum_list: list[dict] = []
    for use in enums_used:
        if not any(item["name"] == use["name"] for item in enum_list):
            enum_list.append(
                {
                    "name": use["name"],
                    "values": [js_string(value) for value in use["values"]],
                    "storage": "native" if use["native"] else "check",
                }
            )
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": None,
        "source": {"kind": "orm", "format": "sqlalchemy"},
        "tables": [mapped["table"] for mapped in tables],
        "enums": enum_list,
        "notes": notes,
    }


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    if not re.search(r"\b(from|import)\s+sqlalchemy\b", text) or re.search(r"\bfrom\s+sqlmodel\b", text):
        return 0
    return 1 if re.search(r"\b(mapped_column|Column)\s*\(", text) else 0.5


SQLALCHEMY_READER = OrmReader(
    id="sqlalchemy", label="SQLAlchemy", language="python", detect=_detect, read=_read_sqlalchemy
)
