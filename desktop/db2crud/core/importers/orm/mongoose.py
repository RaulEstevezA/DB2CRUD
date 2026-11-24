"""Reads Mongoose schemas into the physical schema: every model is a collection, with the fields of its schema (types,
`required`, defaults, `enum` and limits, references), its nested documents and arrays, the indexes of the fields and
of `schema.index(…)`, and `timestamps`. A schema only used inside others is a nested document. A reference to one
document of a collection the code declares is read as a foreign key, which MongoDB does not check. Mirrors
web/src/core/importers/orm/mongoose.ts.

A schema call is {fields, options, indexes, line}; a model call {name, schema, collection, line}; a reading {schemas,
enums, notes, path}, whose path holds the schemas being read, so one that nests itself ends."""

import re

from ...js import is_number, number_text
from ...model.naming import pluralize
from ...schema.checks import check_of
from ...schema.documents import OBJECT_ID, id_column, is_object_id
from ..code.lexer import Cursor, LexError, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .expressions import boolean_of, literal_of, name_of, number_of, read_arguments, string_of, text_of
from .types import OrmReader
from .typescript import NAMED


def entries_of(expr: dict | None) -> dict:
    """The entries of an object literal, by key."""
    entries: dict = {}
    if expr is not None and expr["kind"] == "dict":
        for entry in expr["entries"]:
            key = name_of(entry["key"])
            if key is None:
                key = string_of(entry["key"])
            if key:
                entries[key] = entry["value"]
    return entries


def arg(args: list, index: int) -> dict | None:
    return args[index] if len(args) > index else None


def _skip_type_arguments(tokens: list, index: int) -> int:
    """After a name, the `<…>` of its type arguments, when it has them."""
    if index >= len(tokens) or tokens[index].value != "<":
        return index
    depth = 0
    for at in range(index, len(tokens)):
        if tokens[at].value == "<":
            depth += 1
        elif tokens[at].value == ">":
            depth -= 1
            if depth == 0:
                return at + 1
        elif tokens[at].value == ";":
            return index
    return index


_DECLARATIONS = ("const", "let", "var")


def _read_calls(files: list[dict]) -> tuple[dict, list[dict]]:
    schemas: dict[str, dict] = {}
    models: list[dict] = []
    indexes: list[dict] = []
    inline = 0
    for file in files:
        try:
            tokens = tokenize(file["text"], TYPESCRIPT_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)

        def arguments_at(index: int, cursor: Cursor = cursor, source: str = file["text"]) -> list:
            cursor.index = index
            return read_arguments(cursor, source, NAMED, ")")[0]

        def value_at(position: int, tokens: list = tokens) -> str | None:
            return tokens[position].value if 0 <= position < len(tokens) else None

        def call_of(index: int, name: str, tokens: list = tokens, value_at=value_at) -> int | None:
            """The index after the `(` of a call to name or to something.name, when the token starts one."""
            if tokens[index].value != name or tokens[index].kind != "ident":
                return None
            opening = _skip_type_arguments(tokens, index + 1)
            return opening + 1 if value_at(opening) == "(" else None

        for index, token in enumerate(tokens):
            schema_at = call_of(index, "Schema")
            if schema_at is not None:
                start = index - 2 if value_at(index - 1) == "." else index
                if value_at(start - 1) != "new":
                    continue
                # const orderSchema: Schema<Order> = new Schema(…), or a schema written where it is used
                variable = None
                if value_at(start - 2) == "=":
                    at = start - 3
                    while at > 0 and tokens[at].value not in _DECLARATIONS and tokens[at].value != ";":
                        at -= 1
                    if tokens[at].value in _DECLARATIONS:
                        variable = value_at(at + 1)
                args = arguments_at(schema_at)
                if not args or args[0]["kind"] != "dict":
                    continue
                if variable:
                    schemas[variable] = {
                        "fields": args[0],
                        "options": entries_of(arg(args, 1)),
                        "indexes": [],
                        "line": token.line,
                    }
                continue
            model_at = call_of(index, "model")
            if model_at is not None:
                args = arguments_at(model_at)
                name = string_of(arg(args, 0))
                if not name or len(args) < 2:
                    continue
                given = args[1]
                schema = name_of(given) if given["kind"] == "name" else None
                # model('Tag', new Schema({ … })): the schema has no variable
                if given["kind"] == "call" and name_of(given) == "Schema":
                    schema = f"#{inline}"
                    inline += 1
                    schemas[schema] = {
                        "fields": arg(given["args"], 0),
                        "options": entries_of(arg(given["args"], 1)),
                        "indexes": [],
                        "line": token.line,
                    }
                if schema:
                    models.append(
                        {
                            "name": name,
                            "schema": schema,
                            "collection": string_of(arg(args, 2)),
                            "line": token.line,
                        }
                    )
                continue
            if (
                token.value == "index"
                and value_at(index - 1) == "."
                and value_at(index + 1) == "("
                and index >= 2
                and tokens[index - 2].kind == "ident"
            ):
                indexes.append({"schema": tokens[index - 2].value, "args": arguments_at(index + 2)})
    for item in indexes:
        if item["schema"] in schemas:
            schemas[item["schema"]]["indexes"].append(
                {"fields": arg(item["args"], 0), "options": entries_of(arg(item["args"], 1))}
            )
    return schemas, models


_TYPES = {
    "String": {"sql": "String", "kind": "text"},
    "Number": {"sql": "Number", "kind": "float", "bits": 64},
    "Double": {"sql": "Double", "kind": "float", "bits": 64},
    "Int32": {"sql": "Int32", "kind": "integer", "bits": 32},
    "BigInt": {"sql": "BigInt", "kind": "integer", "bits": 64},
    "Boolean": {"sql": "Boolean", "kind": "boolean"},
    "Date": {"sql": "Date", "kind": "datetime", "timezone": True},
    "Decimal128": {"sql": "Decimal128", "kind": "decimal"},
    "UUID": {"sql": "UUID", "kind": "uuid"},
    "Buffer": {"sql": "Buffer", "kind": "binary"},
    "ObjectId": OBJECT_ID,
    "Map": {"sql": "Map", "kind": "json"},
    "Mixed": {"sql": "Mixed", "kind": "json"},
    "Object": {"sql": "Mixed", "kind": "json"},
}

# The names a type may be written as: 'string', Schema.Types.ObjectID, Bool
_ALIASES = {"ObjectID": "ObjectId", "Oid": "ObjectId", "Bool": "Boolean", "Long": "BigInt", "Schema": ""}


def _type_named(name: str | None) -> dict | None:
    if not name:
        return None
    plain = _ALIASES.get(name, name)
    return _TYPES.get(plain) or _TYPES.get(plain[:1].upper() + plain[1:])


def _setting(expr: dict | None) -> dict | None:
    """A setting of a field, without the message it may carry: [true, 'Why?']."""
    if expr is not None and expr["kind"] == "list":
        return arg(expr["items"], 0)
    return expr


def _is_settings(expr: dict) -> bool:
    """Whether an object literal is the settings of a field: it has a `type` that is not a field called so."""
    given = entries_of(expr).get("type")
    return given is not None and not (given["kind"] == "dict" and "type" in entries_of(given))


def _type_of(expr: dict, where: str, reading: dict) -> dict | None:
    """The type of a field: a name, a schema, an array of one, or a nested document."""
    if expr["kind"] == "list":
        if not expr["items"]:
            return {"sql": "[]", "kind": "array", "items": _TYPES["Mixed"]}
        first = expr["items"][0]
        settings = entries_of(first) if first["kind"] == "dict" and _is_settings(first) else None
        item = _type_of(settings["type"] if settings is not None else first, where, reading)
        if item is None:
            return None
        values = enum_values(settings.get("enum")) if settings is not None else None
        # A document written in a list has an identifier too
        if (
            settings is None
            and first["kind"] == "dict"
            and item["kind"] == "json"
            and item.get("fields") is not None
            and not any(field["name"] == "_id" for field in item["fields"])
        ):
            item = {**item, "fields": [{**id_column(), "nullable": True}, *item["fields"]]}
        items = _enum_type(where, values, reading) if values else item
        return {"sql": f"[{items['sql']}]", "kind": "array", "items": items}
    if expr["kind"] == "dict":
        if not expr["entries"]:
            return _TYPES["Mixed"]
        return {
            "sql": "Object",
            "kind": "json",
            "fields": [field["column"] for field in _fields_of(expr, where, reading)],
        }
    if expr["kind"] == "call" and name_of(expr) == "Schema":
        schema = {"fields": arg(expr["args"], 0), "options": entries_of(arg(expr["args"], 1))}
        return _nested(schema, where, reading)
    name = expr["value"] if expr["kind"] == "string" else name_of(expr)
    schema = reading["schemas"].get(name) if name else None
    if schema is not None:
        if name in reading["path"]:
            return _TYPES["Mixed"]
        return _nested(schema, where, {**reading, "path": [*reading["path"], name]})
    return _type_named(name)


def _nested(schema: dict, where: str, reading: dict) -> dict:
    """A nested document: Mongoose gives it an _id of its own unless it is told not to."""
    fields = [field["column"] for field in _fields_of(schema["fields"], where, reading)]
    if boolean_of(schema["options"].get("_id")) is not False and not any(field["name"] == "_id" for field in fields):
        fields.insert(0, {**id_column(), "nullable": True})
    return {"sql": "Object", "kind": "json", "fields": fields}


def enum_values(expr: dict | None) -> list | None:
    values_expr = entries_of(expr).get("values") if expr is not None and expr["kind"] == "dict" else expr
    if values_expr is None or values_expr["kind"] != "list":
        return None
    literals = (literal_of(item) for item in values_expr["items"])
    values = [value for value in literals if isinstance(value, str) or is_number(value)]
    return values or None


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _enum_type(where: str, values: list, reading: dict) -> dict:
    name = re.sub(r"[^A-Za-z0-9_]+", "_", where)
    if not any(item["name"] == name for item in reading["enums"]):
        reading["enums"].append({"name": name, "values": [_text(value) for value in values], "storage": "check"})
    return {"sql": "String", "kind": "enum", "name": name}


def quoted(values: list) -> str:
    return ", ".join(
        number_text(value) if not isinstance(value, str) else "'" + value.replace("'", "''") + "'" for value in values
    )


_NOW = re.compile(r"Date\.now\(\)|new Date\(\)")
_UUID = re.compile(r"randomUUID\(\)|new (\w+\.)*UUID\(\)")


def _fields_of(expr: dict | None, where: str, reading: dict) -> list[dict]:
    """The fields of a schema or of a nested document: {column, checks, ref, unique, index}. where is the path of the
    field, for the notes and the enums."""
    nested_field = "." in where
    result = []
    for name, value in entries_of(expr).items():
        path = f"{where}.{name}"
        settings = entries_of(value) if value["kind"] == "dict" and _is_settings(value) else {}
        read = _type_of(settings.get("type") or value, path, reading)
        if read is None:
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
            "type": read if read is not None else {"sql": text_of(value), "kind": "unknown"},
            "nullable": boolean_of(_setting(settings.get("required"))) is not True and name != "_id",
        }
        checks = []
        values = enum_values(settings.get("enum"))
        text = column["type"]["kind"] == "text"
        if values and text and nested_field:
            column["type"] = _enum_type(path, values, reading)
        elif values and not nested_field:
            checks.append(check_of(f"{name} IN ({quoted(values)})"))

        def limit(key: str, settings: dict = settings):
            return number_of(_setting(settings.get(key)))

        if column["type"]["kind"] == "text" and limit("maxlength") is not None:
            column["type"] = {**column["type"], "length": limit("maxlength")}
        if not nested_field:
            if limit("min") is not None and column["type"]["kind"] != "datetime":
                checks.append(check_of(f"{name} >= {number_text(limit('min'))}"))
            if limit("max") is not None and column["type"]["kind"] != "datetime":
                checks.append(check_of(f"{name} <= {number_text(limit('max'))}"))
            if limit("minlength") is not None:
                checks.append(check_of(f"LENGTH({name}) >= {number_text(limit('minlength'))}"))
        initial = settings.get("default")
        if initial is not None:
            other = initial["text"] if initial["kind"] == "other" else ""
            if initial["kind"] == "name" and ".".join(initial["path"]) == "Date.now":
                column["generated"] = "now"
            elif _NOW.search(other):
                column["generated"] = "now"
            elif _UUID.search(other):
                column["generated"] = "uuid"
            else:
                literal = literal_of(initial)
                if literal is not None:
                    column["default"] = {"kind": "literal", "value": literal}
        ref = string_of(settings.get("ref"))
        if ref is None and settings.get("ref") is not None and settings["ref"]["kind"] == "name":
            ref = name_of(settings["ref"])
        result.append(
            {
                "column": column,
                "checks": checks,
                "ref": ref if ref and column["type"]["kind"] != "array" else None,
                "unique": boolean_of(_setting(settings.get("unique"))) is True,
                "index": boolean_of(settings.get("index")) is True,
            }
        )
    return result


def _timestamps_of(expr: dict | None) -> tuple[str | None, str | None]:
    """The names of the two dates `timestamps` adds: their own, or those the options give."""
    if boolean_of(expr) is True:
        return "createdAt", "updatedAt"
    if expr is None or expr["kind"] != "dict":
        return None, None
    entries = entries_of(expr)

    def name(key: str) -> str | None:
        if boolean_of(entries.get(key)) is False:
            return None
        given = string_of(entries.get(key))
        return given if given is not None else key

    return name("createdAt"), name("updatedAt")


def _read_mongoose(files: list[dict]) -> dict:
    schemas, models = _read_calls(files)
    enums: list[dict] = []
    notes: list[dict] = []
    tables: list[dict] = []
    pending = []
    by_model: dict[str, dict] = {}
    for model in models:
        schema = schemas.get(model["schema"])
        if schema is None or model["name"] in by_model:
            continue
        name = model["collection"]
        if name is None:
            name = string_of(schema["options"].get("collection"))
        if name is None:
            name = pluralize(model["name"].lower())
        table = {
            "name": name,
            "columns": [],
            "primaryKey": ["_id"],
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": model["name"],
            "origin": {"line": model["line"], "column": 1},
        }
        reading = {"schemas": schemas, "enums": enums, "notes": notes, "path": [model["schema"]]}
        for field in _fields_of(schema["fields"], name, reading):
            column = field["column"]
            table["columns"].append(column)
            table["checks"].extend(field["checks"])
            if field["ref"]:
                pending.append((table, column["name"], field["ref"]))
            if field["unique"] and column["name"] != "_id":
                table["uniques"].append({"columns": [column["name"]]})
            elif field["index"] and column["type"]["kind"] != "array":
                table["indexes"].append({"columns": [column["name"]]})
        identifier = next((column for column in table["columns"] if column["name"] == "_id"), None)
        if identifier is None:
            table["columns"].insert(0, id_column())
        elif is_object_id(identifier["type"]):
            identifier["generated"] = "uuid"
        created, updated = _timestamps_of(schema["options"].get("timestamps"))
        for date, generated in ((created, "now"), (updated, "onUpdateNow")):
            if not date:
                continue
            existing = next((item for item in table["columns"] if item["name"] == date), None)
            if existing is not None:
                existing["generated"] = generated
            else:
                table["columns"].append(
                    {"name": date, "type": _TYPES["Date"], "nullable": True, "generated": generated}
                )
        for index in schema["indexes"]:
            add_index(
                table,
                list(entries_of(index["fields"])),
                boolean_of(index["options"].get("unique")) is True,
                string_of(index["options"].get("name")),
                notes,
            )
        tables.append(table)
        by_model[model["name"]] = table
    for table, column_name, model_name in pending:
        target = by_model.get(model_name)
        if target is None:
            notes.append({"code": "orm.unknownReference", "params": {"table": table["name"], "column": column_name}})
            continue
        table["foreignKeys"].append(
            {"columns": [column_name], "references": {"table": target["name"], "columns": ["_id"]}}
        )
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": "mongodb",
        "source": {"kind": "orm", "format": "mongoose"},
        "tables": tables,
        "enums": enums,
        "notes": notes,
    }


def add_index(table: dict, columns: list[str], unique: bool, name: str | None, notes: list[dict]) -> None:
    """Adds an index of whole fields; one inside documents or over a list is the database's own business."""
    if not columns or columns == ["_id"]:
        return
    kinds = {column["name"]: column["type"]["kind"] for column in table["columns"]}
    if not all(kinds.get(column) not in (None, "array", "json") for column in columns):
        notes.append({"code": "orm.unreadIndex", "params": {"table": table["name"], "index": ", ".join(columns)}})
        return
    items = table["uniques"] if unique else table["indexes"]
    if not any(item["columns"] == columns for item in items):
        items.append({**({"name": name} if name else {}), "columns": columns})


_NEW_SCHEMA = re.compile(r"\bnew\s+(\w+\.)?Schema\s*(<[^(]*>)?\s*\(")
_IMPORTED = re.compile(r"['\"]mongoose['\"]")
_MODEL = re.compile(r"\bmodel\s*(<[^(]*>)?\s*\(")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    if not _NEW_SCHEMA.search(text):
        return 0
    if _IMPORTED.search(text):
        return 1
    return 0.7 if _MODEL.search(text) else 0


MONGOOSE_READER = OrmReader(id="mongoose", label="Mongoose", language="typescript", detect=_detect, read=_read_mongoose)
