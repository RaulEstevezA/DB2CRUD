"""Turns the active decisions of a design into MongoDB collections with a `$jsonSchema` validator and their
indexes. Embedded models become nested objects; references hold the other document's `_id`. Mirrors
web/src/core/physical/document.ts; keys are added in the same order, since the validators are written as JSON."""

import json
import re

from ..design.types import find_model_design
from ..js import coalesce
from ..model.naming import name_words
from ..model.schema import all_fields, find_enum, find_model
from .naming import column_name, constraint_name, free_name, table_name
from .roles import model_roles

PRIMITIVE_BSON = {
    "string": "string",
    "integer": "int",
    "float": "double",
    "decimal": "decimal",
    "boolean": "bool",
    "date": "date",
    "datetime": "date",
    "time": "string",
    "duration": "string",
    "uuid": "string",
    "binary": "binData",
    "any": None,
}


def build_document(schema: dict, design: dict, naming: dict) -> dict:
    options = {"naming": naming}
    roles = model_roles(schema, design)
    notes: list[dict] = []
    used: set[str] = set()
    collections: list[dict] = []
    names: dict[str, str] = {}
    for model in schema["models"]:
        item = find_model_design(design, model["name"])
        # A model the design does not have yet (the model changed and the design follows a moment later) is left out
        if roles.get(model["name"]) != "stored" or not item:
            continue
        names[model["name"]] = free_name(
            coalesce((item or {}).get("table"), table_name(model["name"], options["naming"])), used
        )

    def id_type(model: str) -> dict:
        """The type of the `_id` other documents store to refer to a model."""
        key = (find_model_design(design, model) or {}).get("key")
        if key and key["status"] == "active" and key["value"]["kind"] == "field":
            found = find_model(schema, model)
            field = (
                next((item for item in all_fields(schema, found) if item["name"] == key["value"]["field"]), None)
                if found
                else None
            )
            if field:
                return _key_schema(field["type"])
        return {"bsonType": "objectId"}

    def type_schema(type_ref: dict, nullable: bool, seen: set[str], path: list[str], scope: dict) -> dict:
        def with_null(bson: dict) -> dict:
            if not nullable:
                return bson
            if "enum" in bson:
                return {**bson, "enum": [*bson["enum"], None]}
            if "bsonType" not in bson:
                return bson
            current = bson["bsonType"]
            return {**bson, "bsonType": [*(current if isinstance(current, list) else [current]), "null"]}

        kind = type_ref["kind"]
        if kind == "primitive":
            bson_type = (
                "long"
                if type_ref["name"] == "integer" and type_ref.get("bits") == 64
                else PRIMITIVE_BSON.get(type_ref["name"])
            )
            return with_null({"bsonType": bson_type} if bson_type else {})
        if kind == "enum":
            definition = find_enum(schema, type_ref["name"])
            return with_null(
                {"enum": [coalesce(value.get("value"), value["name"]) for value in definition["values"]]}
                if definition
                else {"bsonType": "string"}
            )
        if kind == "array":
            return with_null(
                {
                    "bsonType": "array",
                    "items": type_schema(type_ref["items"], type_ref.get("itemsNullable") is True, seen, path, scope),
                }
            )
        if kind == "map":
            return with_null(
                {"bsonType": "object", "additionalProperties": type_schema(type_ref["value"], False, seen, path, scope)}
            )
        if kind == "model":
            if type_ref["name"] in seen:
                notes.append({"code": "cycleEmbedded", "params": {"model": type_ref["name"]}})
                return with_null({"bsonType": "object"})
            return with_null(object_schema(type_ref["name"], {*seen, type_ref["name"]}, path, scope, False))
        return {}

    def object_schema(model: str, seen: set[str], path: list[str], scope: dict, root: bool) -> dict:
        """The validator of a model: its fields, embedded models inside, references as ids."""
        found = find_model(schema, model)
        item = find_model_design(design, model)
        if not found or not item:
            return {"bsonType": "object"}
        properties: dict[str, dict] = {}
        required: list[str] = []
        model_key = item.get("key")
        key = model_key["value"] if model_key and model_key["status"] == "active" else None
        if root:
            properties["_id"] = {} if key and key["kind"] == "field" else {"bsonType": "objectId"}
            required.append("_id")
        fields = all_fields(schema, found)
        for field in fields:
            decided = next((other for other in item["fields"] if other["field"] == field["name"]), None)
            if decided and not decided["include"]:
                continue
            is_key = bool(root and key and key["kind"] == "field" and key["field"] == field["name"])
            name = (
                "_id"
                if is_key
                else coalesce(
                    (decided or {}).get("column"),
                    field.get("serializedName"),
                    column_name(field["name"], options["naming"]),
                )
            )
            field_path = [*path, name]
            optional = field["nullable"] or field["optional"]
            relation = (decided or {}).get("relation")
            if relation and relation["status"] == "pending":
                scope["todos"].append(
                    {"code": "relationPending", "params": {"field": ".".join([*path, field["name"]])}}
                )
                continue
            # Kept on the other side: the other collection stores this document's id (and indexes it)
            if relation and relation["value"] == "child":
                continue
            if relation and relation["value"] == "reference":
                target = _reference_target(field["type"])
                if not target or target not in names:
                    scope["todos"].append(
                        {"code": "targetNotStored", "params": {"field": field["name"], "model": target or ""}}
                    )
                    continue
                # `author` next to `authorId` (Prisma's `@relation(fields: [authorId])`): the id is already stored there
                holder = key_holder(field, fields, item, options)
                if holder:
                    add_index(scope, [*path, holder], False)
                    continue
                identifier = id_type(target)
                bson = {"bsonType": "array", "items": identifier} if field["type"]["kind"] == "array" else identifier
                if field["nullable"]:
                    bson = _nullable_of(bson)
                # Lookups go from the document to the one it refers to; a list of ids is read with its document
                if field["type"]["kind"] != "array":
                    add_index(scope, field_path, False)
            else:
                bson = (
                    _key_schema(field["type"])
                    if is_key
                    else type_schema(field["type"], field["nullable"], seen, field_path, scope)
                )
            if field.get("description"):
                bson = {**bson, "description": field["description"]}
            properties[name] = bson
            if (not optional or is_key) and name not in required:
                required.append(name)
            unique = (decided or {}).get("unique")
            if not is_key and unique and unique["status"] == "active" and unique["value"]:
                add_index(scope, field_path, True)
            if not is_key and decided and decided.get("index"):
                add_index(scope, field_path, False)
        result = {"bsonType": "object"}
        if required:
            result["required"] = required
        result.update({"properties": properties, "additionalProperties": False})
        return result

    def add_index(scope: dict, path: list[str], unique: bool) -> None:
        columns = [".".join(path)]
        if any(index["columns"][0] == columns[0] for index in scope["indexes"]):
            return
        scope["indexes"].append(
            {
                "name": constraint_name("uq" if unique else "ix", scope["collection"], ["_".join(path)]),
                "columns": columns,
                "unique": unique,
            }
        )

    for model in schema["models"]:
        name = names.get(model["name"])
        if not name:
            continue
        item = find_model_design(design, model["name"])
        scope = {"todos": [], "indexes": [], "collection": name}
        if item.get("key") and item["key"]["status"] == "pending":
            scope["todos"].append({"code": "keyPending", "params": {"model": model["name"]}})
        validator = object_schema(model["name"], {model["name"]}, [], scope, True)
        collections.append(
            {
                "name": name,
                "model": model["name"],
                "validator": validator,
                "indexes": scope["indexes"],
                "todos": scope["todos"],
            }
        )
    return {"kind": "document", "collections": collections, "notes": _dedupe(notes)}


def key_holder(field: dict, fields: list[dict], item: dict, options: dict) -> str | None:
    """A scalar field next to a reference that already holds the referenced id."""
    relation = next(
        (annotation for annotation in field.get("annotations") or [] if annotation["name"] == "relation"), None
    )
    named = None
    if relation and relation.get("args"):
        match = re.search(r"fields\s*:\s*\[\s*(\w+)", relation["args"], flags=re.ASCII)
        named = match.group(1) if match else None
    words = "".join([*name_words(field["name"]), "id"])

    def holds(other: dict) -> bool:
        decided = next((candidate for candidate in item["fields"] if candidate["field"] == other["name"]), None)
        return (
            other["name"] != field["name"]
            and (decided is None or decided["include"] is not False)
            and not (decided or {}).get("relation")
            and (other["name"] == named or "".join(name_words(other["name"])) == words)
        )

    holder = next((other for other in fields if holds(other)), None)
    if not holder:
        return None
    decided = next((candidate for candidate in item["fields"] if candidate["field"] == holder["name"]), None)
    return coalesce(
        (decided or {}).get("column"), holder.get("serializedName"), column_name(holder["name"], options["naming"])
    )


def _key_schema(type_ref: dict) -> dict:
    """A number without a size (TypeScript's `number`) used as an id is stored as a whole number."""
    if type_ref["kind"] != "primitive":
        return {}
    if (type_ref["name"] == "float" and type_ref.get("bits") is None) or (
        type_ref["name"] == "integer" and type_ref.get("bits") == 64
    ):
        return {"bsonType": "long"}
    bson_type = PRIMITIVE_BSON.get(type_ref["name"])
    return {"bsonType": bson_type} if bson_type else {}


def _reference_target(type_ref: dict) -> str | None:
    if type_ref["kind"] == "model":
        return type_ref["name"]
    if type_ref["kind"] == "array" and type_ref["items"]["kind"] == "model":
        return type_ref["items"]["name"]
    return None


def _nullable_of(bson: dict) -> dict:
    if "bsonType" not in bson:
        return bson
    current = bson["bsonType"]
    return {**bson, "bsonType": [*(current if isinstance(current, list) else [current]), "null"]}


def _dedupe(notes: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result = []
    for note in notes:
        key = json.dumps(note, ensure_ascii=False)
        if key not in seen:
            seen.add(key)
            result.append(note)
    return result
