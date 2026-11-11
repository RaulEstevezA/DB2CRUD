"""Proposes an API design for a model schema: which models become resources, their keys, how related models
travel, what the client may send or read of each field, and the standard endpoints of each resource. Every
proposal carries its confidence and its reasons. Mirrors web/src/core/design/propose.ts.

Given the previous design, the proposal keeps every choice the user made where it still applies, so editing
the input or one decision never throws the rest of the review away (see reconcile).
"""

import re

from ..analysis.models import analyze_models, audit_kind, is_secret_name, model_target
from ..api.types import CRUD_OPERATIONS, decision, reason, same_value
from ..model.naming import name_words, pluralize, to_pascal_case
from ..model.schema import FieldDef, ModelDef, ModelSchema, TypeRef, all_fields, find_model


def _keep(fresh: dict, old: dict | None) -> dict:
    """Keeps a decision the user made if the fresh proposal still offers that value."""
    if not old or not old.get("manual"):
        return fresh
    if any(same_value(option, old["value"]) for option in fresh["options"]):
        return {**fresh, "value": old["value"], "status": "active", "manual": True}
    return fresh


def _propose_expose(facts: dict) -> dict:
    options = ["resource", "embedded"]
    if facts["declaredEntity"]:
        return decision("resource", "exact", [reason("entityDeclared")], options)
    key = facts["declaredKey"] if facts["declaredKey"] is not None else facts["namedKey"]
    if key:
        return decision("resource", "high", [reason("hasKey", {"field": key})], options)
    if facts["referencedBy"]:
        owner = facts["referencedBy"][0]
        return decision("embedded", "probable", [reason("valueObject", {"model": owner["model"]})], options)
    return decision("resource", "probable", [reason("standalone")], options)


def _with_option(options: list, value) -> list:
    return options if any(same_value(option, value) for option in options) else [value, *options]


def _propose_key(facts: dict) -> dict:
    generated = [{"kind": "generated", "type": "integer"}, {"kind": "generated", "type": "uuid"}]
    options = [*({"kind": "field", "field": field} for field in facts["keyCandidates"]), *generated]
    if facts["declaredKey"]:
        choice = {"kind": "field", "field": facts["declaredKey"]}
        return decision(
            choice, "exact", [reason("keyDeclared", {"field": facts["declaredKey"]})], _with_option(options, choice)
        )
    if facts["namedKey"]:
        choice = {"kind": "field", "field": facts["namedKey"]}
        return decision(
            choice, "high", [reason("keyNamed", {"field": facts["namedKey"]})], _with_option(options, choice)
        )
    reasons = [reason("keyMissing")]
    if facts["keyCandidates"]:
        reasons.append(reason("keyCandidates", {"fields": ", ".join(facts["keyCandidates"])}))
    return decision(generated[0], "review", reasons, options)


def key_field(resource: dict | None) -> str | None:
    """The key field of a resource, when its key is one of its fields."""
    if not resource or resource["expose"]["value"] != "resource":
        return None
    key = resource.get("key")
    return key["value"]["field"] if key and key["value"]["kind"] == "field" else None


def _propose_access(field: FieldDef, is_key: bool, facts: dict) -> dict:
    options = ["readWrite", "readOnly", "writeOnly"]
    if is_key:
        if facts["declaredKey"] == field["name"] and facts["declaredKeyGenerated"]:
            return decision("readOnly", "exact", [reason("keyGenerated")], options)
        if field["name"].lower() == "id":
            return decision("readOnly", "probable", [reason("keyGenerated")], options)
        return decision("readWrite", "probable", [reason("keyFromClient")], options)
    if field.get("generated"):
        return decision("readOnly", "exact", [reason("generatedValue")], options)
    if is_secret_name(field["name"]):
        return decision("writeOnly", "probable", [reason("secretNamed")], options)
    type_ref = field["type"]
    temporal = type_ref["kind"] == "primitive" and type_ref["name"] in ("datetime", "date")
    if temporal and audit_kind(field["name"]):
        return decision("readOnly", "probable", [reason("auditNamed")], options)
    return decision("readWrite", "high", [reason("plainField")], options)


def _propose_relation(model: ModelDef, target: dict, expose_of) -> dict:
    if expose_of(target["model"]) != "resource":
        return decision("embedded", "exact", [reason("targetIsValue", {"model": target["model"]})], ["embedded"])
    options = ["reference", "embedded"]
    if target["model"] == model["name"]:
        return decision("reference", "high", [reason("selfReference")], options)
    if target["many"]:
        return decision("reference", "probable", [reason("listOfResources", {"model": target["model"]})], options)
    return decision("reference", "high", [reason("targetIsResource", {"model": target["model"]})], options)


def _unknown_name(type_ref: TypeRef) -> str | None:
    """The type name a field leaves undefined, directly or as the items of a list."""
    kind = type_ref["kind"]
    if kind == "unknown":
        return type_ref["name"]
    if kind == "array":
        return _unknown_name(type_ref["items"])
    if kind == "map":
        return _unknown_name(type_ref["value"])
    return None


def default_resource_path(model: str) -> str:
    """Default first segment of the paths of a resource: OrderLine → order-lines."""
    parts = name_words(model)
    if not parts:
        return model.lower()
    parts[-1] = pluralize(parts[-1])
    return "-".join(parts)


def key_param(resource: dict) -> str:
    """Name of the path parameter that identifies one item: the key field, or id for a generated key."""
    field = key_field(resource)
    return field if field is not None else "id"


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def _article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def standard_endpoint(resource: dict, operation: str) -> dict:
    """The standard endpoint of an operation, with its derived method, path, name and summary."""
    path = resource.get("path")
    base = f"/{path if path is not None else default_resource_path(resource['model'])}"
    item = f"{base}/{{{key_param(resource)}}}"
    singular = " ".join(name_words(resource["model"]))
    plural = default_resource_path(resource["model"]).replace("-", " ")
    pascal = to_pascal_case(resource["model"])
    plural_pascal = to_pascal_case(plural)
    shapes = {
        "list": ("GET", base, f"list{plural_pascal}", f"List {plural}"),
        "get": ("GET", item, f"get{pascal}", f"Get {_article(singular)}"),
        "create": ("POST", base, f"create{pascal}", f"Create {_article(singular)}"),
        "replace": ("PUT", item, f"replace{pascal}", f"Replace {_article(singular)}"),
        "update": ("PATCH", item, f"update{pascal}", f"Update part of {_article(singular)}"),
        "delete": ("DELETE", item, f"delete{pascal}", f"Delete {_article(singular)}"),
    }
    method, endpoint_path, name, summary = shapes[operation]
    endpoint = {
        "id": f"{resource['model']}.{operation}",
        "operation": operation,
        "enabled": True,
        "method": method,
        "path": endpoint_path,
        "name": name,
        "summary": summary,
        "access": "default",
        "roles": [],
    }
    if operation == "list":
        return {**endpoint, "pagination": True, "filters": [], "sort": []}
    return endpoint


def _propose_endpoints(resource: dict, previous: dict | None) -> list[dict]:
    """The endpoints of a resource: the previous ones where the user changed them, fresh ones otherwise. A
    standard endpoint whose path the user did not write follows a new key or resource path."""
    fresh = [standard_endpoint(resource, operation) for operation in CRUD_OPERATIONS]
    if not previous or previous["expose"]["value"] != "resource":
        return fresh
    kept = []
    for old in previous["endpoints"]:
        if old["operation"] == "custom" or old.get("pathEdited"):
            kept.append(old)
        else:
            path = next(item for item in fresh if item["operation"] == old["operation"])["path"]
            kept.append({**old, "path": path})
    # A standard operation missing from the previous design (an older project file) is added back
    for endpoint in fresh:
        if not any(old["id"] == endpoint["id"] for old in kept):
            kept.append(endpoint)
    return kept


def propose_design(schema: ModelSchema, previous: dict | None = None) -> dict:
    """Proposes the API design of a schema. The manual choices and endpoint edits of the previous design are
    kept where they apply; the previous design is not modified."""
    facts = analyze_models(schema)

    def previous_of(model: str) -> dict | None:
        if not previous:
            return None
        return next((item for item in previous["resources"] if item["model"] == model), None)

    # Exposure first: relations depend on whether their target is a resource
    expose: dict[str, dict] = {}
    for model in schema["models"]:
        old = previous_of(model["name"])
        expose[model["name"]] = _keep(_propose_expose(facts[model["name"]]), old["expose"] if old else None)

    def expose_of(model: str):
        return expose[model]["value"] if model in expose else None

    resources = []
    for model in schema["models"]:
        model_facts = facts[model["name"]]
        old = previous_of(model["name"])
        exposed = expose[model["name"]]
        key = (
            _keep(_propose_key(model_facts), old.get("key") if old else None)
            if exposed["value"] == "resource"
            else None
        )
        key_name = key["value"]["field"] if key and key["value"]["kind"] == "field" else None
        fields = []
        for field in all_fields(schema, model):
            was = next((item for item in old["fields"] if item["field"] == field["name"]), None) if old else None
            include = was.get("include") if was else None
            design = {
                "field": field["name"],
                "include": include if include is not None else True,
                "access": _keep(
                    _propose_access(field, field["name"] == key_name, model_facts), was and was.get("access")
                ),
            }
            target = model_target(field["type"])
            if target and find_model(schema, target["model"]):
                relation = _propose_relation(model, target, expose_of)
                design["relation"] = _keep(relation, was and was.get("relation"))
            unknown = _unknown_name(field["type"])
            if unknown:
                fresh = decision("any", "review", [reason("unknownType", {"type": unknown})], ["any", "string"])
                design["unknownType"] = _keep(fresh, was and was.get("unknownType"))
            # The key always travels: it can never be left out
            if field["name"] == key_name:
                design["include"] = True
            fields.append(design)
        resource = {"model": model["name"], "expose": exposed, "fields": fields, "endpoints": []}
        if key:
            resource["key"] = key
        if old and old.get("path"):
            resource["path"] = old["path"]
        resource["endpoints"] = _propose_endpoints(resource, old) if exposed["value"] == "resource" else []
        resources.append(resource)
    return {"resources": resources}


def reconcile(previous: dict | None, schema: ModelSchema) -> dict:
    """The same proposal with the user's choices kept: used whenever the input or a decision changes."""
    return propose_design(schema, previous)
