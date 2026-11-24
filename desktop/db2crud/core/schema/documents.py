"""What the readers of document databases (MongoDB) share: the types of its values and the column every collection has
as its key. A collection is a table whose columns are the fields of its documents; a nested document is a json column
that says its fields. Mirrors web/src/core/schema/documents.ts."""

OBJECT_ID = {"sql": "ObjectId", "kind": "text", "length": 24, "fixed": True, "objectId": True}


def id_column() -> dict:
    """The _id MongoDB gives a document that brings none."""
    return {"name": "_id", "type": dict(OBJECT_ID), "nullable": False, "generated": "uuid"}


def is_object_id(column_type: dict) -> bool:
    return column_type["kind"] == "text" and column_type.get("objectId") is True


def nested_fields(column_type: dict) -> list[dict] | None:
    """The fields of a nested document, or of each document of an array of them."""
    if column_type["kind"] == "array":
        return nested_fields(column_type["items"])
    return column_type.get("fields") if column_type["kind"] == "json" else None
