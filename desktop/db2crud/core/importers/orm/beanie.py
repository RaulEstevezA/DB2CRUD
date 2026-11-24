"""Reads Beanie documents into the physical schema: every `Document` is a collection (named by its `Settings`, or by the
class), with the fields of its annotations and of the classes it extends, their `Field(...)` (alias, default, limits),
its indexes (`Indexed`, `Settings.indexes`) and the Pydantic models it holds as nested documents. A `Link` is kept as
what Beanie stores, a document of its own (`{ $ref, $id }`), so it is not read as a foreign key. Mirrors
web/src/core/importers/orm/beanie.ts.

An annotation is {type, args, optional, calls}: its type, whether it may be None, and the calls `Annotated` and
`Indexed` add to it. A reading is {classes, enums, used, notes, path}."""

import re

from ...js import number_text
from ...schema.checks import check_of
from ...schema.documents import OBJECT_ID, id_column, is_object_id
from ..code.lexer import Cursor, tokenize
from ..code.python import PYTHON_LEXER
from .expressions import boolean_of, literal_of, name_of, number_of, read_expression, string_of
from .mongoose import add_index
from .python import assignment_of, attributes_of, class_of, empty_table, is_now, is_uuid, read_modules
from .types import OrmReader

_OBJECT = {"sql": "object", "kind": "json"}
_DATE = {"sql": "date", "kind": "datetime", "timezone": True}
_DECIMAL = {"sql": "decimal", "kind": "decimal"}
_TEXT = {"sql": "str", "kind": "text"}
_INT = {"sql": "int", "kind": "integer", "bits": 64}
_DOUBLE = {"sql": "double", "kind": "float", "bits": 64}
_UUID = {"sql": "UUID", "kind": "uuid"}
_BINARY = {"sql": "binData", "kind": "binary"}

_TYPES = {
    "str": _TEXT,
    "EmailStr": _TEXT,
    "AnyUrl": _TEXT,
    "HttpUrl": _TEXT,
    "SecretStr": _TEXT,
    "int": _INT,
    "PositiveInt": _INT,
    "NonNegativeInt": _INT,
    "Int64": {"sql": "long", "kind": "integer", "bits": 64},
    "float": _DOUBLE,
    "PositiveFloat": _DOUBLE,
    "NonNegativeFloat": _DOUBLE,
    "timedelta": _DOUBLE,
    "Decimal": _DECIMAL,
    "DecimalAnnotation": _DECIMAL,
    "Decimal128": _DECIMAL,
    "bool": {"sql": "bool", "kind": "boolean"},
    "datetime": _DATE,
    "AwareDatetime": _DATE,
    "NaiveDatetime": _DATE,
    "date": _DATE,
    "UUID": _UUID,
    "UUID4": _UUID,
    "bytes": _BINARY,
    "Binary": _BINARY,
    "BsonBinary": _BINARY,
    "PydanticObjectId": OBJECT_ID,
    "ObjectId": OBJECT_ID,
    "Any": _OBJECT,
    "object": _OBJECT,
    "dict": _OBJECT,
    "Dict": _OBJECT,
    "Mapping": _OBJECT,
    "Link": _OBJECT,
}

_LISTS = {"list", "List", "set", "Set", "Sequence", "tuple", "Tuple", "Iterable"}


def _split_top(text: str, separator: str) -> list[str]:
    """The parts of a text between a separator, outside brackets and texts."""
    parts = []
    depth = 0
    quote = ""
    current = ""
    for char in text:
        if quote:
            quote = "" if char == quote else quote
        elif char in "\"'":
            quote = char
        elif char in "[({":
            depth += 1
        elif char in "])}":
            depth -= 1
        if char == separator and depth == 0 and not quote:
            parts.append(current.strip())
            current = ""
        else:
            current += char
    if current.strip():
        parts.append(current.strip())
    return parts


def _expression_of(text: str) -> dict:
    return read_expression(Cursor(tokenize(text, PYTHON_LEXER)), text)


def _last(text: str) -> str:
    """The last name of a path: `datetime.datetime` → `datetime`."""
    return text.split(".")[-1].strip()


_QUOTED = re.compile(r"^([\"'])([\s\S]*)\1\Z")
_GENERIC = re.compile(r"([\w.]+)\s*\[([\s\S]*)\]")
_CALL = re.compile(r"[\w.]+\s*\(")


def _annotation_of(written: str) -> dict:
    text = _QUOTED.sub(r"\2", written.strip())
    options = _split_top(text, "|")
    if len(options) > 1:
        rest = [item for item in options if item != "None"]
        inner = _annotation_of(rest[0] if len(rest) == 1 else "Any")
        return {**inner, "optional": inner["optional"] or len(rest) < len(options)}
    generic = _GENERIC.fullmatch(text)
    if generic:
        name = _last(generic[1])
        args = _split_top(generic[2], ",")
        first = args[0] if args else "Any"
        if name == "Optional":
            return {**_annotation_of(first), "optional": True}
        if name == "Union":
            return _annotation_of(" | ".join(args))
        if name == "Annotated":
            inner = _annotation_of(first)
            calls = [item for item in map(_expression_of, args[1:]) if item["kind"] == "call"]
            return {**inner, "calls": [*inner["calls"], *calls]}
        return {"type": name, "args": args, "optional": False, "calls": []}
    call = _expression_of(text) if _CALL.match(text) else None
    if call is not None and call["kind"] == "call":
        first = call["args"][0] if call["args"] else None
        # Indexed(str, unique=True): the type is the first argument
        indexed = name_of(call) == "Indexed" and first is not None and first["kind"] == "name"
        inner = _annotation_of(".".join(first["path"]) if indexed else "Any")
        return {**inner, "calls": [*inner["calls"], call]}
    return {"type": _last(text), "args": [], "optional": False, "calls": []}


def _enum_type(name: str, values: list[str], reading: dict) -> dict:
    if not any(other["name"] == name for other in reading["used"]):
        reading["used"].append({"name": name, "values": values, "storage": "check"})
    return {"sql": name, "kind": "enum", "name": name}


def _type_of(annotation: dict, where: str, reading: dict) -> dict | None:
    name, args = annotation["type"], annotation["args"]
    if name in _LISTS:
        item = _type_of(_annotation_of(args[0] if args else "Any"), where, reading)
        return item and {"sql": f"{name}[{', '.join(args)}]" if args else name, "kind": "array", "items": item}
    if name == "Literal":
        values = [literal_of(_expression_of(item)) for item in args]
        return _enum_type(where, [item for item in values if isinstance(item, str)], reading)
    enum = reading["enums"].get(name)
    if enum:
        values = [member["value"] for member in enum["members"]]
        if not all(isinstance(value, str) for value in values):
            return dict(_INT)
        return _enum_type(name, values, reading)
    if name in _TYPES:
        return dict(_TYPES[name])
    item = reading["classes"].get(name)
    if not item:
        return None
    if name in reading["path"]:
        return dict(_OBJECT)
    inside = {**reading, "path": [*reading["path"], name]}
    return {"sql": name, "kind": "json", "fields": [read["column"] for read in _columns_of(item, where, inside)]}


_SKIPPED = {"ClassVar", "BackLink", "PrivateAttr"}
_BASES = re.compile(r"(Document|TimeSeries|View)")


def _is_document(definition: dict, reading: dict, seen: tuple[str, ...] = ()) -> bool:
    for base in definition["bases"]:
        name = _last(base)
        parent = reading["classes"].get(name)
        if not parent:
            if _BASES.fullmatch(name):
                return True
        elif name not in seen and _is_document(parent, reading, (*seen, name)):
            return True
    return False


_NOW_TEXT = re.compile(r"\b(now|utcnow)\(")
_UUID_TEXT = re.compile(r"\buuid4\(")
_BOUNDS = (("ge", ">="), ("gt", ">"), ("le", "<="), ("lt", "<"))


def _columns_of(definition: dict, where: str, reading: dict) -> list[dict]:
    nested = "." in where
    result = []
    for item in attributes_of(definition, reading["classes"], lambda _base: True):
        if not item["annotation"] or item["name"].startswith("_") or item["name"] in ("model_config", "revision_id"):
            continue
        annotation = _annotation_of(item["annotation"])
        if annotation["type"] in _SKIPPED or any(_annotation_of(arg)["type"] in _SKIPPED for arg in annotation["args"]):
            continue
        value_expr = item["value"]
        is_call = value_expr is not None and value_expr["kind"] == "call"
        calls = [*annotation["calls"], *([value_expr] if is_call else [])]
        fields = [call for call in calls if name_of(call) == "Field"]

        def given(name: str, fields: list = fields) -> dict | None:
            return next((call["named"][name] for call in fields if name in call["named"]), None)

        name = string_of(given("alias"))
        if name is None:
            name = string_of(given("serialization_alias"))
        if name is None:
            name = "_id" if item["name"] == "id" and not nested else item["name"]
        path = f"{where}.{name}"
        column_type = _type_of(annotation, path, reading)
        if column_type is None:
            table, _, inner = path.partition(".")
            reading["notes"].append(
                {"code": "orm.unknownType", "params": {"table": table, "column": inner, "type": item["annotation"]}}
            )
            column_type = {"sql": item["annotation"], "kind": "unknown"}
        column = {
            "name": name,
            "type": column_type,
            "nullable": annotation["optional"] and (name != "_id" or nested),
        }
        value = value_expr if not (is_call and name_of(value_expr) == "Field") else None
        if value is None:
            value = given("default")
        if value is None:
            value = next((call["args"][0] for call in fields if call["args"]), None)
        factory = given("default_factory")
        made = factory if factory is not None else value
        text = factory["text"] if factory is not None and factory["kind"] == "other" else ""
        if is_now(made) or _NOW_TEXT.search(text):
            column["generated"] = "now"
        elif (column_type["kind"] == "uuid" and (is_uuid(made) or _UUID_TEXT.search(text))) or (
            name == "_id" and is_object_id(column_type)
        ):
            column["generated"] = "uuid"
        elif factory is not None or (value is not None and value["kind"] in ("list", "dict")):
            column["nullable"] = True
        elif value is not None:
            literal = literal_of(value)
            member = value["path"] if value["kind"] == "name" and len(value["path"]) >= 2 else None
            enum = reading["enums"].get(member[-2]) if member else None
            of_enum = next((one for one in enum["members"] if one["name"] == member[-1]), None) if enum else None
            if of_enum:
                column["default"] = {"kind": "literal", "value": of_enum["value"]}
            elif literal is not None:
                column["default"] = {"kind": "literal", "value": literal}
        checks = []
        longest = number_of(given("max_length"))
        shortest = number_of(given("min_length"))
        if column_type["kind"] == "text" and not is_object_id(column_type):
            if longest is not None:
                column["type"] = {**column_type, "length": longest}
            if shortest is not None and shortest > 0:
                checks.append(check_of(f"LENGTH({name}) >= {number_text(shortest)}"))
        for key, op in _BOUNDS:
            bound = number_of(given(key))
            if bound is not None:
                checks.append(check_of(f"{name} {op} {number_text(bound)}"))
        if annotation["type"].startswith("Positive"):
            checks.append(check_of(f"{name} > 0"))
        if annotation["type"].startswith("NonNegative"):
            checks.append(check_of(f"{name} >= 0"))
        if nested and checks:
            column["checks"] = checks
            checks = []
        indexed = next((call for call in annotation["calls"] if name_of(call) == "Indexed"), None)
        index = None
        if indexed is not None:
            index = {
                "unique": boolean_of(indexed["named"].get("unique")) is True,
                "name": string_of(indexed["named"].get("name")),
            }
        result.append({"column": column, "checks": checks, "index": index})
    return result


def _setting_of(definition: dict, name: str, reading: dict, seen: tuple[str, ...] = ()) -> dict | None:
    """What the `Settings` class of a document says, its own or that of a class it extends."""
    found = _own_setting(definition, name)
    if found is not None:
        return found
    for base in definition["bases"]:
        parent = reading["classes"].get(_last(base))
        if not parent or parent["name"] in seen:
            continue
        found = _setting_of(parent, name, reading, (*seen, definition["name"]))
        if found is not None:
            return found
    return None


def _own_setting(definition: dict, name: str) -> dict | None:
    for statement in definition["body"]:
        inner = class_of(statement)
        if not inner or inner["name"] != "Settings":
            continue
        for item in map(assignment_of, inner["body"]):
            if item and item["name"] == name:
                if item["value"] is not None:
                    return item["value"]
                break
    return None


def _index_keys(expr: dict | None) -> list[str]:
    """The fields of an index: `"name"`, `[("name", 1)]`, or the argument of `IndexModel`."""
    single = string_of(expr)
    if single is not None:
        return [single]
    if expr is None or expr["kind"] != "list":
        return []
    result = []
    for item in expr["items"]:
        name = string_of(item)
        if name is None and item["kind"] == "list" and item["items"]:
            name = string_of(item["items"][0])
        if name is not None:
            result.append(name)
    return result


def _read_beanie(files: list[dict]) -> dict:
    _, definitions, enums = read_modules(files)
    classes = {definition["name"]: definition for definition in definitions}
    notes: list[dict] = []
    used: list[dict] = []
    tables: list[dict] = []
    root = {"classes": classes, "enums": enums, "used": used, "notes": notes, "path": []}
    documents = [definition for definition in definitions if _is_document(definition, root)]
    for definition in documents:
        parents = [classes[_last(base)] for base in definition["bases"] if _last(base) in classes]
        # The documents of a root share its collection, and a class others extend with no name of its own is only their
        # base
        if any(
            _is_document(parent, root) and boolean_of(_setting_of(parent, "is_root", root)) is True
            for parent in parents
        ):
            continue
        extended = any(
            other is not definition and any(_last(base) == definition["name"] for base in other["bases"])
            for other in documents
        )
        own_name = _own_setting(definition, "name")
        if extended and own_name is None and boolean_of(_own_setting(definition, "is_root")) is not True:
            continue
        name = string_of(own_name)
        table = empty_table(definition["name"] if name is None else name, definition["line"])
        table["primaryKey"] = ["_id"]
        table["entity"] = definition["name"]
        read = _columns_of(definition, table["name"], {**root, "path": [definition["name"]]})
        for field in read:
            table["columns"].append(field["column"])
            table["checks"] += field["checks"]
        if not any(column["name"] == "_id" for column in table["columns"]):
            table["columns"].insert(0, id_column())
        for field in read:
            if field["index"]:
                add_index(table, [field["column"]["name"]], field["index"]["unique"], field["index"]["name"], notes)
        indexes = _setting_of(definition, "indexes", root)
        for item in indexes["items"] if indexes is not None and indexes["kind"] == "list" else []:
            if item["kind"] == "call":
                keys = item["args"][0] if item["args"] else item["named"].get("keys")
                unique = boolean_of(item["named"].get("unique")) is True
                add_index(table, _index_keys(keys), unique, string_of(item["named"].get("name")), notes)
            else:
                add_index(table, _index_keys(item), False, None, notes)
        tables.append(table)
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": "mongodb",
        "source": {"kind": "orm", "format": "beanie"},
        "tables": tables,
        "enums": used,
        "notes": notes,
    }


_IMPORTED = re.compile(r"\b(from|import)\s+beanie\b")


def _detect(files: list[dict]) -> float:
    return 1 if _IMPORTED.search("\n".join(file["text"] for file in files)) else 0


BEANIE_READER = OrmReader(id="beanie", label="Beanie", language="python", detect=_detect, read=_read_beanie)
