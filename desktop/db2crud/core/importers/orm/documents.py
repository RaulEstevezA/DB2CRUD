"""Deduces the collections of a MongoDB database from sample documents: what `mongoexport` and Compass write (JSON,
Extended JSON, one document per line), what mongosh prints (`ObjectId('…')`, `ISODate('…')`), a script that inserts
them, or an object with a list per collection. Documents say what there is, not what there must be, so it is careful: a
field is only required when enough documents have it, and unique values, limits and lists of values are never deduced. No
value of a document goes into the schema. Mirrors web/src/core/importers/orm/documents.ts.

A value is {"kind": "object", "entries"}, {"kind": "array", "items"} or a scalar {"kind", "text"?}; what is found of a
collection {"name", "named", "line", "documents"}."""

import re

from ...js import trim_start
from ...schema.documents import OBJECT_ID, id_column, is_object_id
from ..code.lexer import LexError, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .types import OrmReader

# With fewer documents, being in all of them says little: nothing is required
ENOUGH = 5
# An object with more keys than this, few of them shared, holds data in its keys
MANY_KEYS = 40
# Deeper documents are cut: MongoDB allows 100 levels
MAX_DEPTH = 100

# Reading the values

# The types of Extended JSON, by their key
_EXTENDED = {
    "$oid": "objectId",
    "$date": "date",
    "$numberInt": "whole",
    "$numberLong": "whole",
    "$numberDouble": "double",
    "$numberDecimal": "decimal",
    "$uuid": "uuid",
    "$binary": "binary",
    "$timestamp": "other",
    "$regularExpression": "other",
    "$regex": "other",
    "$code": "other",
    "$symbol": "text",
    "$minKey": "other",
    "$maxKey": "other",
    "$undefined": "null",
}

# The functions mongosh writes values with
_CALLS = {
    "ObjectId": "objectId",
    "ISODate": "date",
    "Date": "date",
    "Int32": "whole",
    "NumberInt": "whole",
    "Long": "whole",
    "NumberLong": "whole",
    "Double": "double",
    "Decimal128": "decimal",
    "NumberDecimal": "decimal",
    "UUID": "uuid",
    "Binary": "binary",
    "BinData": "binary",
    "HexData": "binary",
    "Buffer": "binary",
    "Timestamp": "other",
    "MinKey": "other",
    "MaxKey": "other",
    "Code": "other",
    "BSONRegExp": "other",
    "RegExp": "other",
    "DBRef": "other",
}

_UUID_SUBTYPES = ("04", "4", "03", "3")
# true, null… as mongosh and JSON write them
_WORDS = {
    "true": "bool",
    "false": "bool",
    "null": "null",
    "undefined": "null",
    "NaN": "double",
    "Infinity": "double",
}


def _scalar(kind: str, inner: dict | None) -> dict:
    if inner is not None and inner.get("text") is not None:
        return {"kind": kind, "text": inner["text"]}
    return {"kind": kind}


def _is_uuid_subtype(value: dict | None) -> bool:
    return value is not None and value.get("text") in _UUID_SUBTYPES


def _extended(value: dict) -> dict:
    """An object of Extended JSON is the value it writes: `{ "$oid": "…" }`."""
    first = next(iter(value["entries"]), None)
    kind = _EXTENDED.get(first) if first is not None else None
    if not kind:
        return value
    inner = value["entries"][first]
    if kind == "binary":
        entries = inner["entries"] if inner["kind"] == "object" else {}
        sub_type = entries.get("subType") if inner["kind"] == "object" else value["entries"].get("$type")
        return {"kind": "uuid" if _is_uuid_subtype(sub_type) else "binary"}
    return _scalar(kind, inner)


_ENDS = re.compile(r"[,:\[\]{}();]")


class _Reader:
    """The values of a text, token by token; None where something is not a value."""

    def __init__(self, tokens: list) -> None:
        self.index = 0
        self._tokens = tokens

    @property
    def done(self) -> bool:
        return self.index >= len(self._tokens)

    def token(self, offset: int = 0):
        at = self.index + offset
        return self._tokens[at] if at < len(self._tokens) else None

    def is_(self, value: str, offset: int = 0) -> bool:
        token = self.token(offset)
        return token is not None and token.kind != "string" and token.value == value

    def _eat(self, value: str) -> bool:
        if not self.is_(value):
            return False
        self.index += 1
        return True

    def _skip_to(self, close: str, before: str | None = None) -> None:
        """Moves to a closing bracket of this level, or to something before it, past what is not a value: `... 3 more
        items`."""
        depth = 0
        while not self.done:
            if depth == 0 and (self.is_(close) or (before is not None and self.is_(before))):
                return
            if self.is_("{") or self.is_("[") or self.is_("("):
                depth += 1
            elif self.is_("}") or self.is_("]") or self.is_(")"):
                depth -= 1
            if depth < 0:
                return
            self.index += 1

    def value(self, depth: int = 0) -> dict | None:
        token = self.token()
        if token is None or depth > MAX_DEPTH:
            return None
        if token.kind == "string":
            self.index += 1
            return {"kind": "text", "text": token.value}
        following = self.token(1)
        negative = self.is_("-") and ((following is not None and following.kind == "number") or self.is_("Infinity", 1))
        if token.kind == "number" or negative:
            return self._number(negative)
        if self._eat("{"):
            return self._object(depth)
        if self._eat("["):
            return self._array(depth)
        if token.kind != "ident":
            return None
        if token.value == "new":
            self.index += 1
            return self.value(depth)
        if token.value in _WORDS:
            self.index += 1
            return {"kind": _WORDS[token.value]}
        return self._call(token.value, depth)

    def _number(self, negative: bool) -> dict:
        if negative:
            self.index += 1
        text = ""
        end = self.token().start
        # The parts of one number touch each other: `1e-7`
        while not self.done and self.token().start == end and not _ENDS.fullmatch(self.token().value):
            text += self.token().value
            end = self.token().end
            self.index += 1
        return {"kind": "whole" if re.fullmatch(r"[0-9]+", text) else "double", "text": text}

    def _call(self, name: str, depth: int) -> dict | None:
        kind = _CALLS.get(name)
        # `Binary.createFromBase64('…', 0)`, `Long.fromBits(…)`
        at = 1
        method = self.token(2)
        if kind and self.is_(".", 1) and method is not None and method.kind == "ident":
            at = 3
        if not kind or not self.is_("(", at):
            return None
        self.index += at + 1
        args = []
        while not self.done and not self.is_(")"):
            arg = self.value(depth + 1)
            if arg is None:
                break
            args.append(arg)
            if not self._eat(","):
                break
        self._skip_to(")")
        self._eat(")")
        first = args[0] if args else None
        second = args[1] if len(args) > 1 else None
        # BinData(4, '…'), Binary.createFromBase64('…', 4)
        if kind == "binary" and _is_uuid_subtype(first if name == "BinData" else second):
            return {"kind": "uuid"}
        return _scalar(kind, first)

    def _object(self, depth: int) -> dict:
        entries: dict[str, dict] = {}
        while not self.done and not self.is_("}"):
            key = self.token()
            if key.kind not in ("string", "ident", "number") or not self.is_(":", 1):
                break
            self.index += 2
            value = self.value(depth + 1)
            # Something it does not know is still a field
            if value is None:
                self._skip_to("}", ",")
            entries[key.value] = {"kind": "other"} if value is None else value
            if not self._eat(","):
                break
        self._skip_to("}")
        self._eat("}")
        return _extended({"kind": "object", "entries": entries})

    def _array(self, depth: int) -> dict:
        items = []
        # `[Object]` and `[Array]` are what mongosh does not print
        if (self.is_("Object") or self.is_("Array")) and self.is_("]", 1):
            self.index += 2
            return {"kind": "cut"}
        while not self.done and not self.is_("]"):
            value = self.value(depth + 1)
            if value is None:
                break
            items.append(value)
            if not self._eat(","):
                break
        self._skip_to("]")
        self._eat("]")
        return {"kind": "array", "items": items}


# Finding the documents


def _objects(values: list[dict]) -> list[dict]:
    return [value for value in values if value["kind"] == "object"]


def _documents_of(value: dict | None) -> list[dict]:
    """The documents of a value: itself, or those of a list."""
    if value is None:
        return []
    return _objects(value["items"] if value["kind"] == "array" else [value])


_EXTENSION = re.compile(r"\.(json|ndjson|jsonl|js|txt|bson)\Z", re.IGNORECASE)


def _collection_of(file: str) -> str | None:
    """`shop.customers.json`, as Compass names what it exports → `customers`; None when the name says nothing."""
    name = _EXTENSION.sub("", file.split("/")[-1], count=1).split(".")[-1]
    return None if name in ("", "input") else name


_INSERTS = ("insertMany", "insertOne", "insert")
_FINDS = ("find", "findOne", "aggregate")

_INSERT = re.compile(
    r"""\bdb\s*\.\s*[\w$]+(\s*\(\s*["'`][^"'`]+["'`]\s*\))?\s*\.\s*(insertMany|insertOne|insert)\s*\(""", re.ASCII
)
_VALIDATOR = re.compile(r"\$jsonSchema")
_FIND = re.compile(r"\bdb\s*\.\s*[\w$]+(\s*\([^)]*\))?\s*\.\s*(find|findOne|aggregate)\s*\(", re.ASCII)
_ID = re.compile(r"""(["']_id["']|\b_id)\s*:|["']\$oid["']\s*:""", re.ASCII)


def holds_documents(text: str) -> bool:
    """Whether a text holds documents of MongoDB: JSON or what mongosh prints, with an `_id`, or a script that inserts
    them."""
    if _INSERT.search(text):
        return True
    if _VALIDATOR.search(text):
        return False
    printed = trim_start(text)[:1] in ("[", "{") or _FIND.search(text)
    return bool(printed and _ID.search(text))


_PATTERN = re.compile(
    r""""(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`"""
    r"""|([:,\[]\s*)/(?![/*])(?:\\.|[^\\/\n])+/[a-z]*(?=\s*[,}\]])"""
)


def _without_patterns(text: str) -> str:
    """A text with its regular expressions (`re: /it's/i`) as calls: what they hold is not tokens."""
    return _PATTERN.sub(lambda match: match[0] if match[1] is None else f"{match[1]}RegExp()", text)


def _read_file(file: dict) -> list[dict]:
    """The documents of a file, by collection."""
    try:
        reader = _Reader(tokenize(_without_patterns(file["text"]), TYPESCRIPT_LEXER))
    except LexError:
        return []
    found: list[dict] = []

    def add(name: str, named: bool, line: int, documents: list[dict]) -> None:
        known = next((item for item in found if item["name"] == name), None)
        if known:
            known["documents"] += documents
        elif documents:
            found.append({"name": name, "named": named, "line": line, "documents": list(documents)})

    current = _collection_of(file["name"])
    while not reader.done:
        token = reader.token()
        if reader.is_("db") and reader.is_(".", 1):
            # db.customers.insertMany([…]), db.getCollection('customers').find()
            first = reader.token(2)
            name = first.value if first is not None else ""
            at = 3
            if name == "getCollection" and reader.is_("(", at):
                given = reader.token(at + 1)
                name = given.value if given is not None else ""
                at += 3
            # A name with points: db.audit.entries.find()
            while reader.is_(".", at) and reader.is_(".", at + 2):
                name += f".{reader.token(at + 1).value}"
                at += 2
            method = reader.token(at + 1).value if reader.is_(".", at) and reader.is_("(", at + 2) else ""
            if method in _INSERTS:
                reader.index += at + 3
                add(name, True, token.line, _documents_of(reader.value()))
                continue
            if method in _FINDS:
                # What it prints comes after the call, and the calls that follow it
                current = name
                reader.index += at + 2
                while True:
                    depth = 0
                    while True:
                        if reader.is_("("):
                            depth += 1
                        if reader.is_(")"):
                            depth -= 1
                        reader.index += 1
                        if reader.done or depth <= 0:
                            break
                    if not reader.is_(".") or not reader.is_("(", 2):
                        break
                    reader.index += 2
                continue
            reader.index += 1
            continue
        if not reader.is_("{") and not reader.is_("["):
            reader.index += 1
            continue
        value = reader.value()
        if value is None:
            continue
        # An object with a list per collection
        if value["kind"] == "object" and "_id" not in value["entries"] and value["entries"]:
            lists = list(value["entries"].values())
            if all(
                item["kind"] == "array" and item["items"] and len(_objects(item["items"])) == len(item["items"])
                for item in lists
            ):
                for name, item in value["entries"].items():
                    add(name, True, token.line, _documents_of(item))
                continue
        add("documents" if current is None else current, current is not None, token.line, _documents_of(value))
    return found


# Deducing

_NUMBERS = ("whole", "double", "decimal")

_SIMPLE = {
    "objectId": OBJECT_ID,
    "text": {"sql": "string", "kind": "text"},
    "whole": {"sql": "long", "kind": "integer", "bits": 64},
    "double": {"sql": "double", "kind": "float", "bits": 64},
    "decimal": {"sql": "decimal", "kind": "decimal"},
    "bool": {"sql": "bool", "kind": "boolean"},
    "date": {"sql": "date", "kind": "datetime", "timezone": True},
    "binary": {"sql": "binData", "kind": "binary"},
    "uuid": {"sql": "UUID", "kind": "uuid"},
}

_DATA = re.compile(
    r"^[0-9]+\Z|^[0-9a-f]{24}\Z|^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9]{4}-[0-9]{2}(-[0-9]{2})?|[@/]|^https?:", re.IGNORECASE
)


def _is_data(key: str) -> bool:
    """A key that is data and not the name of a field: an identifier, a number, a date, an address."""
    return key == "" or key.startswith("$") or _DATA.search(key) is not None


def _object_type() -> dict:
    return {"sql": "object", "kind": "json"}


def _type_of(values: list[dict], path: str, table: str, notes: list[dict]) -> dict:
    def note(code: str, **params) -> None:
        notes.append({"code": code, "params": {"table": table, "column": path, **params}})

    present = [value for value in values if value["kind"] != "null"]
    kinds = sorted({value["kind"] for value in present})
    if not kinds:
        note("documents.onlyNull")
        return _object_type()
    if "cut" in kinds:
        note("documents.cut")
        return _object_type()
    if len(kinds) > 1:
        # A number is whole or not from one document to another
        if all(kind in _NUMBERS for kind in kinds):
            return dict(_SIMPLE["decimal" if "decimal" in kinds else "double"])
        note("documents.mixedTypes", types=", ".join(kinds))
        return _object_type()
    kind = kinds[0]
    if kind == "array":
        items = [item for value in present for item in value["items"]]
        if not items:
            note("documents.emptyList")
            return {"sql": "array", "kind": "array", "items": _object_type()}
        item_type = _type_of(items, path, table, notes)
        return {"sql": f"array<{item_type['sql']}>", "kind": "array", "items": item_type}
    if kind == "object":
        keys = {key for document in present for key in document["entries"]}
        shared = sum(len(document["entries"]) for document in present) / len(present)
        if any(_is_data(key) for key in keys) or (len(keys) > MANY_KEYS and shared < len(keys) / 4):
            note("documents.dataKeys")
            return _object_type()
        # An empty document says nothing
        if not keys:
            return _object_type()
        return {"sql": "object", "kind": "json", "fields": _fields_of(present, f"{path}.", table, notes)}
    if kind in _SIMPLE:
        return dict(_SIMPLE[kind])
    note("documents.otherType")
    return _object_type()


def _fields_of(documents: list[dict], prefix: str, table: str, notes: list[dict]) -> list[dict]:
    fields: dict[str, list[dict]] = {}
    for document in documents:
        for name, value in document["entries"].items():
            fields.setdefault(name, []).append(value)
    result = []
    for name, values in fields.items():
        always = (
            len(documents) >= ENOUGH
            and len(values) == len(documents)
            and all(value["kind"] != "null" for value in values)
        )
        result.append(
            {
                "name": name,
                "type": _type_of(values, prefix + name, table, notes),
                "nullable": prefix != "" if name == "_id" else not always,
            }
        )
    return result


def _identifiers(value: dict | None) -> list[str]:
    """The identifiers of a value that is one, or a list of them."""
    if value is None:
        return []
    if value["kind"] == "array":
        return [found for item in value["items"] for found in _identifiers(item)]
    return [value["text"].lower()] if value["kind"] == "objectId" and value.get("text") else []


def _read_documents(files: list[dict]) -> dict:
    found: list[dict] = []
    for file in files:
        if not holds_documents(file["text"]):
            continue
        for item in _read_file(file):
            known = next((other for other in found if other["name"] == item["name"]), None)
            if known:
                known["documents"] += item["documents"]
            else:
                found.append(item)
    notes: list[dict] = []
    tables = []
    for item in found:
        name, documents = item["name"], item["documents"]
        if not item["named"]:
            notes.append({"code": "documents.unnamed", "params": {"table": name}})
        code = "documents.few" if len(documents) < ENOUGH else "documents.deduced"
        notes.append({"code": code, "params": {"table": name, "count": len(documents)}})
        columns = _fields_of(documents, "", name, notes)
        key = next((column for column in columns if column["name"] == "_id"), None)
        if key is None:
            columns.insert(0, id_column())
        elif is_object_id(key["type"]):
            key["generated"] = "uuid"
        tables.append(
            {
                "name": name,
                "columns": columns,
                "primaryKey": ["_id"],
                "foreignKeys": [],
                "uniques": [],
                "indexes": [],
                "checks": [],
                "origin": {"line": item["line"], "column": 1},
            }
        )
    # An identifier of MongoDB is never repeated: a field that has one of another collection's points to it
    owners: dict[str, str] = {}
    for item in found:
        for document in item["documents"]:
            for one in _identifiers(document["entries"].get("_id")):
                owners[one] = item["name"]
    for item, table in zip(found, tables, strict=True):
        for column in table["columns"]:
            name = column["name"]
            if name == "_id" or not is_object_id(column["type"]):
                continue
            targets = {
                owners[one]
                for document in item["documents"]
                for one in _identifiers(document["entries"].get(name))
                if one in owners
            }
            if len(targets) != 1:
                continue
            target = targets.pop()
            table["foreignKeys"].append({"columns": [name], "references": {"table": target, "columns": ["_id"]}})
            notes.append(
                {"code": "documents.reference", "params": {"table": item["name"], "column": name, "target": target}}
            )
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": "mongodb",
        "source": {"kind": "orm", "format": "documents"},
        "tables": tables,
        "enums": [],
        "notes": notes,
    }


def _detect(files: list[dict]) -> float:
    # Code of an ORM may insert documents too: it says more
    return 0.3 if any(holds_documents(file["text"]) for file in files) else 0


DOCUMENTS_READER = OrmReader(
    id="documents", label="MongoDB documents", language="json", detect=_detect, read=_read_documents
)
