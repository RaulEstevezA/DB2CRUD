"""Reads the validators of MongoDB collections into the physical schema: a mongosh script (`db.createCollection(…, {
validator: { $jsonSchema } })` with its `createIndex`), or what `db.getCollectionInfos()` prints. Each `$jsonSchema`
gives the fields of a collection, with their types, what is required, the values and limits of each and its nested
documents. Mirrors web/src/core/importers/orm/mongodb.ts."""

import re

from ...js import is_number, number_text
from ...schema.checks import check_of
from ...schema.documents import OBJECT_ID, id_column, is_object_id
from ..code.lexer import Cursor, LexError, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .expressions import (
    boolean_of,
    literal_of,
    number_of,
    read_arguments,
    read_expression,
    string_of,
    text_of,
)
from .mongoose import add_index, arg, entries_of, quoted
from .types import OrmReader
from .typescript import NAMED


def _strings_of(expr: dict | None) -> list[str]:
    items = expr["items"] if expr is not None and expr["kind"] == "list" else []
    return [value for value in (string_of(item) for item in items) if value is not None]


_TYPES = {
    "objectId": OBJECT_ID,
    "string": {"sql": "string", "kind": "text"},
    "int": {"sql": "int", "kind": "integer", "bits": 32},
    "integer": {"sql": "int", "kind": "integer", "bits": 64},
    "long": {"sql": "long", "kind": "integer", "bits": 64},
    "double": {"sql": "double", "kind": "float", "bits": 64},
    "number": {"sql": "number", "kind": "float", "bits": 64},
    "decimal": {"sql": "decimal", "kind": "decimal"},
    "bool": {"sql": "bool", "kind": "boolean"},
    "boolean": {"sql": "bool", "kind": "boolean"},
    "date": {"sql": "date", "kind": "datetime", "timezone": True},
    "timestamp": {"sql": "timestamp", "kind": "datetime", "timezone": True},
    "binData": {"sql": "binData", "kind": "binary"},
    "object": {"sql": "object", "kind": "json"},
}

_NUMBERS = ("int", "long", "double", "decimal", "number")


def _type_of(schema: dict, where: str, reading: dict) -> tuple[dict, bool]:
    """The type a bsonType (or type) names, and whether null is one of those it takes."""
    declared = schema.get("bsonType") or schema.get("type")
    if declared is not None and declared["kind"] == "list":
        names = _strings_of(declared)
    else:
        single = string_of(declared)
        names = [single] if single is not None else []
    named = [name for name in names if name != "null"]
    nullable = len(named) < len(names)
    # Whole numbers that may be of either size are kept in the larger one
    if len(named) == 2 and "int" in named and "long" in named:
        name = "long"
    else:
        name = named[0] if len(named) == 1 else None
    if name == "array":
        items = schema.get("items")
        item = (
            _type_of(entries_of(items), where, reading)[0]
            if items is not None and items["kind"] == "dict"
            else _TYPES["object"]
        )
        return {
            "sql": f"array<{item['sql']}>",
            "kind": "array",
            "items": _with_enum(item, entries_of(items), where, reading),
        }, nullable
    if name in (None, "object") and "properties" in schema:
        fields = [field["column"] for field in _fields_of(schema, where, reading)]
        return {"sql": "object", "kind": "json", "fields": fields}, nullable
    if name is not None and name in _TYPES:
        return _TYPES[name], nullable
    if named and all(item in _NUMBERS for item in named):
        return _TYPES["number"], nullable
    # A list of values says the type of a field that has none
    values = schema.get("enum")
    first = (
        literal_of(values["items"][0]) if values is not None and values["kind"] == "list" and values["items"] else None
    )
    if not names and isinstance(first, str):
        return _TYPES["string"], nullable
    if not names and is_number(first):
        return _TYPES["number"], nullable
    if not names or len(names) > 1:
        return _TYPES["object"], nullable
    return {"sql": " | ".join(names), "kind": "unknown"}, nullable


def _enum_values(expr: dict | None) -> list:
    if expr is None or expr["kind"] != "list":
        return []
    literals = (literal_of(item) for item in expr["items"])
    return [value for value in literals if isinstance(value, str) or is_number(value)]


def _with_enum(column_type: dict, schema: dict, where: str, reading: dict) -> dict:
    """A text with a list of values inside a document, as an enum."""
    values = _enum_values(schema.get("enum"))
    if not values or column_type["kind"] != "text":
        return column_type
    name = re.sub(r"[^A-Za-z0-9_]+", "_", where)
    if not any(item["name"] == name for item in reading["enums"]):
        texts = [value if isinstance(value, str) else number_text(value) for value in values]
        reading["enums"].append({"name": name, "values": texts, "storage": "check"})
    return {"sql": "string", "kind": "enum", "name": name}


def _fields_of(schema: dict, where: str, reading: dict) -> list[dict]:
    required = _strings_of(schema.get("required"))
    nested = "." in where
    result = []
    for name, value in entries_of(schema.get("properties")).items():
        field = entries_of(value)
        path = f"{where}.{name}"
        column_type, takes_null = _type_of(field, path, reading)
        if column_type["kind"] == "unknown":
            reading["notes"].append(
                {
                    "code": "orm.unknownType",
                    "params": {
                        "table": where.split(".")[0],
                        "column": path[path.index(".") + 1 :],
                        "type": text_of(value),
                    },
                }
            )
        column = {
            "name": name,
            "type": column_type,
            "nullable": (name not in required or takes_null) and name != "_id",
        }
        checks = []
        values = _enum_values(field.get("enum"))
        if nested:
            column["type"] = _with_enum(column["type"], field, path, reading)
        elif values:
            checks.append(check_of(f"{name} IN ({quoted(values)})"))

        def number(key: str, field: dict = field):
            return number_of(field.get(key))

        if column["type"]["kind"] == "text" and number("maxLength") is not None and not is_object_id(column["type"]):
            column["type"] = {**column["type"], "length": number("maxLength")}
        if number("minimum") is not None:
            op = ">" if boolean_of(field.get("exclusiveMinimum")) is True else ">="
            checks.append(check_of(f"{name} {op} {number_text(number('minimum'))}"))
        if number("maximum") is not None:
            op = "<" if boolean_of(field.get("exclusiveMaximum")) is True else "<="
            checks.append(check_of(f"{name} {op} {number_text(number('maximum'))}"))
        if number("minLength") is not None:
            checks.append(check_of(f"LENGTH({name}) >= {number_text(number('minLength'))}"))
        if nested and checks:
            column["checks"] = checks
            checks = []
        comment = string_of(field.get("description"))
        if comment:
            column["comment"] = comment
        result.append({"column": column, "checks": checks})
    return result


def _table_of(name: str, schema: dict, line: int, reading: dict) -> dict:
    table = {
        "name": name,
        "columns": [],
        "primaryKey": ["_id"],
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": line, "column": 1},
    }
    for field in _fields_of(entries_of(schema), name, reading):
        table["columns"].append(field["column"])
        table["checks"].extend(field["checks"])
    identifier = next((column for column in table["columns"] if column["name"] == "_id"), None)
    if identifier is None:
        table["columns"].insert(0, id_column())
    elif is_object_id(identifier["type"]):
        identifier["generated"] = "uuid"
    return table


def _validator_of(options: dict | None) -> dict | None:
    """The $jsonSchema of the options of a collection."""
    return entries_of(entries_of(options).get("validator")).get("$jsonSchema")


def _read_mongodb(files: list[dict]) -> dict:
    reading = {"enums": [], "notes": []}
    tables: list[dict] = []
    indexes = []

    def add(name: str, schema: dict | None, line: int) -> None:
        # Nothing says what its documents hold
        if schema is None:
            reading["notes"].append(
                {"code": "orm.noValidator", "params": {"table": name}, "origin": {"line": line, "column": 1}}
            )
        if schema is not None and not any(table["name"] == name for table in tables):
            tables.append(_table_of(name, schema, line, reading))

    for file in files:
        try:
            tokens = tokenize(file["text"], TYPESCRIPT_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)

        def arguments_at(index: int, cursor: Cursor = cursor, source: str = file["text"]) -> list:
            cursor.index = index
            return read_arguments(cursor, source, NAMED, ")")[0]

        # What db.getCollectionInfos() prints, or one validator alone
        if tokens and tokens[0].value in ("[", "{"):
            value = read_expression(cursor, file["text"], NAMED)
            for item in value["items"] if value["kind"] == "list" else [value]:
                entries = entries_of(item)
                name = string_of(entries.get("name"))
                if name:
                    schema = _validator_of(entries.get("options"))
                    add(name, schema if schema is not None else _validator_of(item), 1)
                elif "$jsonSchema" in entries:
                    title = string_of(entries_of(entries["$jsonSchema"]).get("title"))
                    add(title if title is not None else "documents", entries["$jsonSchema"], 1)
            continue
        for index, token in enumerate(tokens):
            if token.kind != "ident" or index + 1 >= len(tokens) or tokens[index + 1].value != "(":
                continue
            if token.value == "createCollection":
                args = arguments_at(index + 2)
                name = string_of(arg(args, 0))
                if name:
                    add(name, _validator_of(arg(args, 1)), token.line)
            elif token.value == "runCommand":
                # db.runCommand({ collMod: 'orders', validator: … })
                command = arg(arguments_at(index + 2), 0)
                name = string_of(entries_of(command).get("collMod"))
                if name is None:
                    name = string_of(entries_of(command).get("create"))
                if name:
                    add(name, _validator_of(command), token.line)
            elif token.value == "createIndex" and index >= 2 and tokens[index - 1].value == ".":
                # db.orders.createIndex(…), db.getCollection('orders').createIndex(…)
                before = tokens[index - 2]
                collection = tokens[index - 3] if before.value == ")" and index >= 3 else before
                indexes.append((collection.value, arguments_at(index + 2)))
    for collection, args in indexes:
        table = next((item for item in tables if item["name"] == collection), None)
        options = entries_of(arg(args, 1))
        if table is not None:
            add_index(
                table,
                list(entries_of(arg(args, 0))),
                boolean_of(options.get("unique")) is True,
                string_of(options.get("name")),
                reading["notes"],
            )
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": "mongodb",
        "source": {"kind": "orm", "format": "mongodb"},
        "tables": tables,
        "enums": reading["enums"],
        "notes": reading["notes"],
    }


_FIELDS = re.compile(r"\b(bsonType|properties)\b")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 0.95 if "$jsonSchema" in text and _FIELDS.search(text) else 0


MONGODB_READER = OrmReader(
    id="mongodb", label="MongoDB validators", language="typescript", detect=_detect, read=_read_mongodb
)
