"""The collections of a document design seen as ODM classes: a class per stored model (with its collection) and
per embedded model, and for each field what it holds. Every ODM writer works from this view, so they all store
the same thing. Mirrors web/src/core/generate/odm/documents.ts.

A document field has `field`, `stored` (the property name in the document), `kind` (`value`, `values`, `map`,
`free`, `embedded` or `reference`), `many`, `target`, `type` (of the value or of the list's items), `enum`,
`required`, `nullable`, `unique`, `indexed` and `id` (it is the document's `_id`). A class has `name`,
`collection` (stored models only), `fields`, `objectId` (the `_id` is MongoDB's own) and `todos`."""

from ...design.types import find_model_design
from ...js import coalesce
from ...model.schema import all_fields, find_enum, find_model, model_of
from ...physical.document import key_holder
from ...physical.naming import column_name
from ...physical.roles import model_roles


def _inner_type(type_ref: dict) -> dict:
    """The type behind lists and maps: `Order[]` → `Order`."""
    if type_ref["kind"] == "array":
        return _inner_type(type_ref["items"])
    if type_ref["kind"] == "map":
        return _inner_type(type_ref["value"])
    return type_ref


def build_document_view(schema: dict, design: dict, physical: dict, naming: dict) -> dict:
    roles = model_roles(schema, design)
    classes = []
    for model in schema["models"]:
        role = roles.get(model["name"])
        if role not in ("stored", "embedded"):
            continue
        item = find_model_design(design, model["name"])
        if not item:
            continue
        collection = next(
            (candidate for candidate in physical["collections"] if candidate["model"] == model["name"]), None
        )
        model_key = item.get("key")
        key = model_key["value"] if model_key and model_key["status"] == "active" else None
        fields = []
        model_fields = all_fields(schema, model)
        for field in model_fields:
            decided = next((candidate for candidate in item["fields"] if candidate["field"] == field["name"]), None)
            if decided and not decided["include"]:
                continue
            relation = (decided or {}).get("relation")
            if relation and (relation["status"] == "pending" or relation["value"] == "child"):
                continue
            is_id = bool(role == "stored" and key and key["kind"] == "field" and key["field"] == field["name"])
            target = model_of(field["type"])
            inner = _inner_type(field["type"])
            kind = "value"
            if target and find_model(schema, target):
                kind = "reference" if relation and relation["value"] == "reference" else "embedded"
            elif field["type"]["kind"] == "map":
                kind = "map"
            elif field["type"]["kind"] == "array":
                kind = "values"
            elif inner["kind"] == "unknown" or (inner["kind"] == "primitive" and inner["name"] == "any"):
                kind = "free"
            # A reference whose target has no collection of its own cannot be written; one whose id is already
            # in another field (`author` next to `authorId`) is that field
            if kind == "reference" and roles.get(target) != "stored":
                continue
            if kind == "reference" and key_holder(field, model_fields, item, {"naming": naming}):
                continue
            entry = {
                "field": field,
                "stored": "_id"
                if is_id
                else coalesce(
                    (decided or {}).get("column"), field.get("serializedName"), column_name(field["name"], naming)
                ),
                "kind": kind,
                "many": field["type"]["kind"] == "array",
            }
            if target:
                entry["target"] = target
            entry["type"] = inner
            if inner["kind"] == "enum" and find_enum(schema, inner["name"]):
                entry["enum"] = find_enum(schema, inner["name"])
            unique = (decided or {}).get("unique")
            entry.update(
                {
                    "required": is_id or (not field.get("optional") and not field.get("nullable")),
                    "nullable": bool(field.get("nullable")),
                    "unique": bool(unique and unique["status"] == "active" and unique["value"] is True),
                    "indexed": (decided or {}).get("index") is True or kind == "reference",
                    "id": is_id,
                }
            )
            fields.append(entry)
        entry = {"name": model["name"]}
        if collection:
            entry["collection"] = collection
        entry.update(
            {
                "fields": fields,
                "objectId": role == "stored" and not (key and key["kind"] == "field"),
                "todos": collection["todos"] if collection else [],
            }
        )
        classes.append(entry)
    return {
        "classes": classes,
        "enums": [
            item
            for item in schema["enums"]
            if any((field.get("enum") or {}).get("name") == item["name"] for cls in classes for field in cls["fields"])
        ],
    }
