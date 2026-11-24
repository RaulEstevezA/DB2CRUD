"""Reads Spring Data MongoDB classes into the physical schema: every `@Document` is a collection, with its fields
(`@Field`, `@Id`, `@Transient`), their Java types, what must be there (`@NotNull` and the like) and its limits, its
indexes (`@Indexed`, `@CompoundIndex`), its references (`@DocumentReference`, `@DBRef`) and the classes it holds as
nested documents. A reference to one document of a collection the code declares is read as a foreign key. Mirrors
web/src/core/importers/orm/springdata.ts.

A reading is {classes, enums, notes, path}, whose path holds the classes being read, so one that nests itself ends; a
field read is {field, column, checks, ref}."""

import re

from ...js import number_text, to_number
from ...schema.checks import check_of
from ...schema.documents import OBJECT_ID, id_column, is_object_id
from .expressions import boolean_of, literal_of, name_of, number_of, string_of
from .jpa import annotation_of, argument_of, calls_of, read_classes, simple_type
from .mongoose import add_index
from .types import OrmReader

_INTEGER = {"kind": "integer", "bits": 32}
_LONG = {"kind": "integer", "bits": 64}
_DOUBLE = {"sql": "double", "kind": "float", "bits": 64}
_DATE = {"sql": "date", "kind": "datetime", "timezone": True}
_OBJECT = {"sql": "object", "kind": "json"}
_DECIMAL = {"sql": "decimal", "kind": "decimal"}
_BINARY = {"sql": "binData", "kind": "binary"}

_TYPES = {
    "String": {"sql": "String", "kind": "text"},
    "Integer": {"sql": "Integer", **_INTEGER},
    "int": {"sql": "int", **_INTEGER},
    "Short": {"sql": "Short", **_INTEGER},
    "short": {"sql": "short", **_INTEGER},
    "Long": {"sql": "long", **_LONG},
    "long": {"sql": "long", **_LONG},
    "Double": _DOUBLE,
    "double": _DOUBLE,
    "Float": _DOUBLE,
    "float": _DOUBLE,
    "BigDecimal": _DECIMAL,
    "Decimal128": _DECIMAL,
    "Boolean": {"sql": "bool", "kind": "boolean"},
    "boolean": {"sql": "bool", "kind": "boolean"},
    "Instant": _DATE,
    "Date": _DATE,
    "LocalDate": _DATE,
    "LocalDateTime": _DATE,
    "UUID": {"sql": "UUID", "kind": "uuid"},
    "Binary": _BINARY,
    "byte[]": _BINARY,
    "ObjectId": OBJECT_ID,
    "Object": _OBJECT,
    "Document": _OBJECT,
    "Map": _OBJECT,
}

_LISTS = {"List", "Set", "Collection", "ArrayList", "LinkedHashSet", "HashSet"}
_PRIMITIVES = {"int", "short", "long", "double", "float", "boolean"}

# What `@Field(targetType = FieldType.…)` stores
_TARGETS = {
    "OBJECT_ID": OBJECT_ID,
    "DECIMAL128": _DECIMAL,
    "STRING": _TYPES["String"],
    "INT32": _TYPES["Integer"],
    "INT64": _TYPES["Long"],
    "DOUBLE": _DOUBLE,
    "DATE_TIME": _DATE,
    "BINARY": _BINARY,
}


def _fields_of_class(item: dict, reading: dict, seen: tuple[str, ...] = ()) -> list[dict]:
    """The fields of a class and of those it extends; constants and what is not stored are left out."""
    base = item["base"]
    parent = reading["classes"].get(base) if base and base not in seen else None
    inherited = _fields_of_class(parent, reading, (*seen, item["name"])) if parent else []
    return [
        *inherited,
        *(
            field
            for field in item["fields"]
            if "static" not in field["modifiers"]
            and "transient" not in field["modifiers"]
            and annotation_of(field["annotations"], "Transient") is None
        ),
    ]


_GENERIC = re.compile(r"<([\s\S]*)>\s*$")
_ARRAY = re.compile(r"\[\]\s*$")


def _generic_of(java: str) -> str:
    """`List<OrderLine>` → `OrderLine`."""
    match = _GENERIC.search(java)
    return match[1].strip() if match else ""


def _type_of(java: str, target: dict | None, where: str, reading: dict) -> dict | None:
    if _ARRAY.search(java) and simple_type(_ARRAY.sub("", java)) != "byte":
        item = _type_of(_ARRAY.sub("", java), target, where, reading)
        return {"sql": java, "kind": "array", "items": item} if item else None
    name = simple_type(java)
    if name in _LISTS:
        item = _type_of(_generic_of(java) or "Object", target, where, reading)
        return {"sql": java, "kind": "array", "items": item} if item else None
    if target:
        return dict(target)
    if name in _TYPES:
        return dict(_TYPES[name])
    item = reading["classes"].get(name)
    if not item:
        return None
    if item["kind"] == "enum":
        if not any(other["name"] == item["name"] for other in reading["enums"]):
            values = [constant["name"] for constant in item["constants"]]
            reading["enums"].append({"name": item["name"], "values": values, "storage": "check"})
        return {"sql": name, "kind": "enum", "name": item["name"]}
    if name in reading["path"]:
        return dict(_OBJECT)
    inside = {**reading, "path": [*reading["path"], name]}
    return {"sql": name, "kind": "json", "fields": [read["column"] for read in _columns_of(item, where, inside)]}


def _stored_name(field: dict) -> str:
    annotation = annotation_of(field["annotations"], "Field")
    for argument in ("name", "value"):
        name = string_of(argument_of(annotation, argument))
        if name is not None:
            return name
    return field["name"]


def _is_id(field: dict) -> bool:
    return annotation_of(field["annotations"], "Id", "MongoId") is not None or field["name"] in ("id", "_id")


def _id_type_of(item: dict, reading: dict) -> dict:
    """The identifier of a class, which its references keep."""
    field = next((field for field in _fields_of_class(item, reading) if _is_id(field)), None)
    name = simple_type(field["type"]) if field else "ObjectId"
    # Spring keeps a text that is an identifier as one
    if name in ("String", "ObjectId"):
        return dict(OBJECT_ID)
    return dict(_TYPES.get(name, OBJECT_ID))


def _bound(field: dict, annotation: str):
    """The limit an annotation such as `@Min(0)` or `@DecimalMin("0.5")` sets."""
    value = argument_of(annotation_of(field["annotations"], annotation), "value")
    found = number_of(value)
    if found is not None:
        return found
    text = string_of(value)
    return to_number(text) if text is not None else None


def _checks_of(field: dict, column: dict) -> list[dict]:
    """The limits of a field; a maximum length goes to its type."""
    name = column["name"]
    checks = []
    size = annotation_of(field["annotations"], "Size")
    longest = number_of(argument_of(size, "max"))
    shortest = number_of(argument_of(size, "min"))
    if column["type"]["kind"] == "text" and not is_object_id(column["type"]):
        if longest is not None:
            column["type"] = {**column["type"], "length": longest}
        if shortest is not None and shortest > 0:
            checks.append(check_of(f"LENGTH({name}) >= {number_text(shortest)}"))
    for annotations, op in ((("Min", "DecimalMin"), ">="), (("Max", "DecimalMax"), "<=")):
        bound = next((value for value in (_bound(field, item) for item in annotations) if value is not None), None)
        if bound is not None:
            checks.append(check_of(f"{name} {op} {number_text(bound)}"))
    if annotation_of(field["annotations"], "Positive"):
        checks.append(check_of(f"{name} > 0"))
    if annotation_of(field["annotations"], "PositiveOrZero"):
        checks.append(check_of(f"{name} >= 0"))
    return checks


def _columns_of(item: dict, where: str, reading: dict) -> list[dict]:
    nested = "." in where
    result = []
    for field in _fields_of_class(item, reading):
        is_id = _is_id(field)
        name = "_id" if is_id else _stored_name(field)
        path = f"{where}.{name}"
        annotations = field["annotations"]
        by_value = annotation_of(annotations, "DBRef") is not None
        reference = by_value or annotation_of(annotations, "DocumentReference") is not None
        many = simple_type(field["type"]) in _LISTS
        target = simple_type(_generic_of(field["type"]) if many else field["type"])
        referred = reading["classes"].get(target) if reference else None
        if reference:
            # A DBRef is a document of its own: { $ref, $id }
            if by_value:
                key = dict(_OBJECT)
            else:
                key = _id_type_of(referred, reading) if referred else dict(OBJECT_ID)
            column_type = {"sql": field["type"], "kind": "array", "items": key} if many else key
        elif is_id:
            column_type = _id_type_of(item, reading)
        else:
            stored = name_of(argument_of(annotation_of(annotations, "Field"), "targetType"))
            column_type = _type_of(field["type"], _TARGETS.get(stored or ""), path, reading)
        if column_type is None:
            table, _, inner = path.partition(".")
            reading["notes"].append(
                {"code": "orm.unknownType", "params": {"table": table, "column": inner, "type": field["type"]}}
            )
            column_type = {"sql": field["type"], "kind": "unknown"}
        required = annotation_of(annotations, "NotNull", "NotBlank", "NotEmpty", "NonNull") is not None
        column = {
            "name": name,
            "type": column_type,
            "nullable": nested if is_id else not required and field["type"] not in _PRIMITIVES,
        }
        if is_id and is_object_id(column_type):
            column["generated"] = "uuid"
        if annotation_of(annotations, "CreatedDate"):
            column["generated"] = "now"
        if annotation_of(annotations, "LastModifiedDate"):
            column["generated"] = "onUpdateNow"
        initializer = field.get("initializer")
        literal = literal_of(initializer) if initializer is not None else None
        if literal is not None and not column.get("generated"):
            column["default"] = {"kind": "literal", "value": literal}
        if (
            column_type["kind"] == "enum"
            and initializer is not None
            and initializer["kind"] == "name"
            and len(initializer["path"]) == 2
        ):
            column["default"] = {"kind": "literal", "value": name_of(initializer)}
        checks = _checks_of(field, column)
        if nested and checks:
            column["checks"] = checks
            checks = []
        ref = referred["name"] if referred and not many and not by_value else None
        result.append({"field": field, "column": column, "checks": checks, "ref": ref})
    return result


_KEY = re.compile(r"['\"]?([\w.]+)['\"]?\s*:\s*(?:-?1|['\"])", re.ASCII)


def _read_spring_data(files: list[dict]) -> dict:
    classes = {item["name"]: item for item in read_classes(files)}
    enums: list[dict] = []
    notes: list[dict] = []
    tables: list[dict] = []
    by_class: dict[str, dict] = {}
    pending: list[tuple[dict, str, str]] = []
    for item in classes.values():
        annotation = annotation_of(item["annotations"], "Document")
        if annotation is None or item["kind"] == "interface":
            continue
        name = string_of(argument_of(annotation, "collection"))
        if name is None:
            name = string_of(argument_of(annotation, "value"))
        if name is None:
            name = item["name"][:1].lower() + item["name"][1:]
        table = {
            "name": name,
            "columns": [],
            "primaryKey": ["_id"],
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": item["name"],
            "origin": {"line": item["line"], "column": 1},
        }
        reading = {"classes": classes, "enums": enums, "notes": notes, "path": [item["name"]]}
        read = _columns_of(item, name, reading)
        for one in read:
            table["columns"].append(one["column"])
            table["checks"] += one["checks"]
            if one["ref"]:
                pending.append((table, one["column"]["name"], one["ref"]))
        if not any(column["name"] == "_id" for column in table["columns"]):
            table["columns"].insert(0, id_column())
        stored: dict[str, str] = {}
        for one in read:
            stored.setdefault(one["field"]["name"], one["column"]["name"])
            indexed = annotation_of(one["field"]["annotations"], "Indexed")
            if indexed is not None:
                unique = boolean_of(argument_of(indexed, "unique")) is True
                index_name = string_of(argument_of(indexed, "name"))
                add_index(table, [one["column"]["name"]], unique, index_name, notes)
        compound = [
            *(other for other in item["annotations"] if name_of(other) == "CompoundIndex"),
            *calls_of(argument_of(annotation_of(item["annotations"], "CompoundIndexes"), "value")),
        ]
        for index in compound:
            keys = [stored.get(key, key) for key in _KEY.findall(string_of(argument_of(index, "def")) or "")]
            unique = boolean_of(argument_of(index, "unique")) is True
            add_index(table, keys, unique, string_of(argument_of(index, "name")), notes)
        tables.append(table)
        by_class[item["name"]] = table
    for table, column, ref in pending:
        target = by_class.get(ref)
        if target:
            table["foreignKeys"].append(
                {"columns": [column], "references": {"table": target["name"], "columns": ["_id"]}}
            )
        else:
            notes.append({"code": "orm.unknownReference", "params": {"table": table["name"], "column": column}})
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": "mongodb",
        "source": {"kind": "orm", "format": "springdata"},
        "tables": tables,
        "enums": enums,
        "notes": notes,
    }


_DOCUMENT = re.compile(r"@Document\b")
_IMPORTED = re.compile(r"org\.springframework\.data\.mongodb\b")
_CALLED = re.compile(r"@Document\s*\(")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    if not _DOCUMENT.search(text):
        return 0
    if _IMPORTED.search(text):
        return 1
    return 0.6 if _CALLED.search(text) else 0


SPRING_DATA_READER = OrmReader(
    id="springdata", label="Spring Data MongoDB", language="java", detect=_detect, read=_read_spring_data
)
