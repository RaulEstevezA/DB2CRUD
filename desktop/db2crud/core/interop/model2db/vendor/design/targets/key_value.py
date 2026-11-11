"""Keys and values (Redis): each stored model is a hash under its own key (`order:42`); a list or a map of it
is a list, set or hash under the owner's key (`order:42:tags`). How the data is read decides most of it, and
the model does not say, so lists of other models wait for the user. Mirrors
web/src/core/design/targets/keyValue.ts."""

from ...model.schema import find_model
from ..analysis import flattenable, has_key, keyable, natural_key
from ..decision import decision, reason
from ..hints import declared_relation, declares_embeddable

SURROGATE_KEYS = [{"kind": "surrogate", "type": "integer"}, {"kind": "surrogate", "type": "uuid"}]


def key_without_field(model: dict, fields: list[dict], options: list) -> dict:
    suggestion = SURROGATE_KEYS[0]
    candidates = [field for field in fields if keyable(field) and natural_key(model, field)]
    if candidates:
        names = ", ".join(field["name"] for field in candidates)
        return decision(suggestion, "review", [reason("keyCandidates", {"fields": names})], options)
    return decision(suggestion, "probable", [reason("keyMissing")], options)


def relation(context: dict, model: dict, field: dict, shape: dict) -> dict:
    declared = declared_relation(field)
    kind = shape["kind"]
    if kind == "model":
        target = shape["target"]
        options = ["reference", *(["flatten"] if flattenable(context, target) else []), "json"]
        if declared == "embedded" or declares_embeddable(find_model(context["schema"], target)):
            return decision(
                "flatten" if "flatten" in options else "json", "exact", [reason("relationDeclared")], options
            )
        if target == model["name"]:
            return decision("reference", "exact", [reason("selfReference")], options)
        if has_key(context, target):
            return decision("reference", "high", [reason("targetHasKey", {"model": target})], options)
        if "flatten" in options:
            return decision("flatten", "probable", [reason("valueObject", {"model": target})], options)
        return decision("json", "probable", [reason("valueAsJson", {"model": target})], options)
    if kind == "models":
        target = shape["target"]
        options = ["child", "json"]
        # A set of the other models' keys, or the whole list as JSON: it depends on how the list is read
        if has_key(context, target):
            return decision("child", "review", [reason("keySet", {"model": target})], options)
        return decision("json", "review", [reason("listAsJson", {"model": target})], options)
    if kind == "values":
        return decision("child", "probable", [reason("valueList")], ["child", "json"])
    if kind == "map":
        options = ["child", "json"] if shape["plain"] else ["json"]
        return decision(options[0], "probable", [reason("valueHash" if shape["plain"] else "mapOfValues")], options)
    confidence = "review" if shape["unknown"] else "probable"
    return decision("json", confidence, [reason("freeShape", {"type": field.get("originalType") or ""})], ["json"])


STRATEGY = {
    "target": "keyvalue",
    "surrogate_keys": SURROGATE_KEYS,
    "key_without_field": key_without_field,
    "relation": relation,
    "foreign_keys": True,
    "whole_numbers": False,
    "enum": lambda name: None,
}
