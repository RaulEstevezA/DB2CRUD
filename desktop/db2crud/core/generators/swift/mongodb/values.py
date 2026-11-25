"""Values between Swift and the documents of MongoDB, by the functions of Bson.swift. Mirrors
web/src/core/generators/swift/mongodb/values.ts."""

from ....schema.documents import is_object_id


def _plain_name(column_type: dict) -> str:
    """The name of a plain value in the functions: `asText` reads it, `ofText` writes it."""
    if is_object_id(column_type):
        return "ObjectId"
    kind = column_type["kind"]
    if kind == "integer":
        return "Int64" if column_type["bits"] == 64 else "Int32"
    if kind == "float":
        return "Float" if column_type["bits"] == 32 else "Double"
    names = {
        "decimal": "Decimal",
        "boolean": "Bool",
        "datetime": "Date",
        "uuid": "UUID",
        "binary": "Data",
        "json": "Any",
        "unknown": "Any",
    }
    return names.get(kind, "Text")


def _nested(column_type: dict, nested: dict | None) -> bool:
    return column_type["kind"] == "json" and column_type.get("fields") is not None and nested is not None


def reads(column_type: dict, nested: dict | None) -> str:
    """The function that reads a value: `Bson.asText`."""
    if column_type["kind"] == "array":
        return f"Bson.asList({reads(column_type['items'], nested)})"
    if _nested(column_type, nested):
        return f"Bson.asNested({nested['path']}.self)"
    return f"Bson.as{_plain_name(column_type)}"


def writes(column_type: dict, nested: dict | None) -> str:
    """The function that writes a value: `Bson.ofText`."""
    if column_type["kind"] == "array":
        return f"Bson.ofList({writes(column_type['items'], nested)})"
    if _nested(column_type, nested):
        return "Bson.ofNested"
    return f"Bson.of{_plain_name(column_type)}"


def encoded(column_type: dict, value: str, nested: dict | None = None) -> str:
    """A value that is there, as a document holds it."""
    return f"try {writes(column_type, nested)}({value})"
