"""The collections of a Model2DB project for MongoDB as db-schema. Their fields are those of the validators Model2DB
builds, read like any other validator (importers/orm/mongodb.py); the design adds what a validator cannot say: which
fields point to another collection, and what each library stores in its own way.
Mirrors web/src/core/interop/model2db/documents.ts."""

from ...importers.orm.mongodb import collections_of
from ...importers.orm.mongoose import add_index
from ...schema.documents import is_object_id, nested_fields
from .vendor.design.types import find_model_design
from .vendor.generate.odm.documents import build_document_view
from .vendor.model.schema import all_fields, find_model, model_of
from .vendor.physical.document import build_document, key_holder


def _library(classes: bool = True, uuid: bool = True, db_ref: bool = False, nested_id: bool = False) -> dict:
    """What a library stores in its own way: `classes`, it writes classes, which name the entities; `uuid`, a UUID is
    MongoDB's own type, not text; `db_ref`, a reference is a DBRef, a document with the identifier inside; `nested_id`,
    the id of a nested document is stored as _id."""
    return {"classes": classes, "uuid": uuid, "db_ref": db_ref, "nested_id": nested_id}


# The outputs of Model2DB for MongoDB (generate/outputs)
DOCUMENT_OUTPUTS: dict[str, dict] = {
    "mongodb": _library(classes=False, uuid=False),
    "pymongo": _library(classes=False, uuid=False),
    "mongoose": _library(),
    "mongoengine": _library(uuid=False),
    "spring-data-mongodb": _library(nested_id=True),
    "beanie": _library(db_ref=True),
}


def _expr_of(value) -> dict:
    """A JSON value as the expression its text would be read as."""
    if isinstance(value, str):
        return {"kind": "string", "value": value}
    if isinstance(value, bool) or value is None:
        return {"kind": "name", "path": ["null" if value is None else str(value).lower()]}
    if isinstance(value, int | float):
        return {"kind": "number", "value": value}
    if isinstance(value, list):
        return {"kind": "list", "items": [_expr_of(item) for item in value]}
    return {
        "kind": "dict",
        "entries": [{"key": {"kind": "string", "value": key}, "value": _expr_of(item)} for key, item in value.items()],
    }


def _replaced(column_type: dict, by: dict) -> dict:
    """The type, or that of the items of a list, replaced."""
    if column_type["kind"] == "array":
        return {"sql": f"array<{by['sql']}>", "kind": "array", "items": _replaced(column_type["items"], by)}
    return dict(by)


def _class_of(view: dict, name: str | None) -> dict | None:
    return next((item for item in view["classes"] if item["name"] == name), None)


def _holds_uuid(field: dict, view: dict) -> bool:
    """What a field holds: for a reference, the key of the model it points to."""
    if field["kind"] == "reference":
        target = _class_of(view, field.get("target"))
        key = next((item for item in target["fields"] if item["id"]), None) if target else None
        return key is not None and key["kind"] == "value" and _holds_uuid(key, view)
    field_type = field["type"]
    return (
        field["kind"] in ("value", "values") and field_type["kind"] == "primitive" and field_type.get("name") == "uuid"
    )


def _as_stored(columns: list[dict], item: dict, view: dict, stores: dict) -> None:
    """The fields of a class as the library stores them."""
    for field in item["fields"]:
        column = next((candidate for candidate in columns if candidate["name"] == field["stored"]), None)
        if column is None:
            continue
        if field["kind"] == "reference" and stores["db_ref"]:
            column["type"] = _replaced(column["type"], {"sql": "DBRef", "kind": "json"})
        elif stores["uuid"] and _holds_uuid(field, view):
            column["type"] = _replaced(column["type"], {"sql": "UUID", "kind": "uuid"})
        nested = _class_of(view, field.get("target")) if field["kind"] == "embedded" else None
        fields = nested_fields(column["type"])
        if nested and fields is not None:
            _as_stored(fields, nested, view, stores)
        own_id = field["field"]["name"] == "id" and field["stored"] == "id"
        if stores["nested_id"] and "collection" not in item and own_id:
            column["name"] = "_id"


def _references(model: str, item: dict, schema: dict, design: dict, naming: dict) -> list[tuple[str, str]]:
    """The fields of the documents of a model that keep the identifier of a document of another collection."""
    found = find_model(schema, model)
    decisions = find_model_design(design, model)
    result = [
        (field["stored"], field["target"])
        for field in item["fields"]
        if field["kind"] == "reference" and not field["many"]
    ]
    if not found or not decisions:
        return result
    # `author` next to `authorId`: the identifier is in the second, and the first is not stored
    fields = all_fields(schema, found)
    for field in fields:
        decided = next((candidate for candidate in decisions["fields"] if candidate["field"] == field["name"]), None)
        target = model_of(field["type"]) if field["type"]["kind"] == "model" else None
        if not target or not decided or not decided["include"]:
            continue
        relation = decided.get("relation")
        if not relation or relation["status"] != "active" or relation["value"] != "reference":
            continue
        column = key_holder(field, fields, decisions, {"naming": naming})
        if column and not any(known == column for known, _ in result):
            result.append((column, target))
    return result


def _same_values(left: dict, right: dict) -> bool:
    """Both sides keep the same kind of value, so one can be looked up by the other."""
    return left["kind"] == right["kind"] and is_object_id(left) == is_object_id(right)


def document_schema(schema: dict, design: dict, naming: dict, output: str) -> dict:
    """The collections Model2DB builds for this design with the output of the project."""
    stores = DOCUMENT_OUTPUTS[output]
    physical = build_document(schema, design, naming)
    view = build_document_view(schema, design, physical, naming)
    reading = {"enums": [], "notes": []}
    tables = collections_of(
        [
            {"name": collection["name"], "schema": _expr_of(collection["validator"])}
            for collection in physical["collections"]
        ],
        reading,
    )
    notes = [{"code": f"model2db.{note['code']}", "params": note["params"]} for note in physical["notes"]]
    by_model: dict[str, dict] = {}
    for collection, table in zip(physical["collections"], tables, strict=True):
        item = _class_of(view, collection["model"])
        by_model[collection["model"]] = table
        if stores["classes"]:
            table["entity"] = collection["model"]
        if item:
            _as_stored(table["columns"], item, view, stores)
        for entry in collection["indexes"]:
            add_index(table, entry["columns"], entry["unique"], entry["name"], reading["notes"])
        for todo in collection["todos"]:
            notes.append({"code": f"model2db.{todo['code']}", "params": {**todo["params"], "table": table["name"]}})
    for model, table in by_model.items():
        item = _class_of(view, model)
        if not item:
            continue
        for column, target in _references(model, item, schema, design, naming):
            other = by_model.get(target)
            source = next((candidate for candidate in table["columns"] if candidate["name"] == column), None)
            key = (
                next((candidate for candidate in other["columns"] if candidate["name"] == "_id"), None)
                if other
                else None
            )
            if source and key and _same_values(source["type"], key["type"]):
                table["foreignKeys"].append(
                    {"columns": [column], "references": {"table": other["name"], "columns": ["_id"]}}
                )
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": "mongodb",
        "source": {"kind": "model2db", "format": output},
        "tables": tables,
        "enums": reading["enums"],
        "notes": [*notes, *reading["notes"]],
    }
