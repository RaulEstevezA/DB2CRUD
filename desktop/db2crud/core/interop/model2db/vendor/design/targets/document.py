"""Documents (MongoDB): values live inside their document; shared or recursive models are referred to.
Mirrors web/src/core/design/targets/document.ts."""

from ...model.schema import find_model
from ..analysis import back_reference, has_key, is_top_level, other_usages, reaches
from ..decision import decision, reason
from ..hints import declared_relation, declares_embeddable

SURROGATE_KEYS = [{"kind": "surrogate", "type": "objectId"}]


def key_without_field(_model: dict, _fields: list[dict], options: list) -> dict:
    return decision(SURROGATE_KEYS[0], "exact", [reason("keyMongo")], options)


def relation(context: dict, model: dict, field: dict, shape: dict) -> dict:
    kind = shape["kind"]
    if kind not in ("model", "models"):
        if kind == "values":
            reasons = [reason("valueArray")]
        elif kind == "map":
            reasons = [reason("mapOfValues")]
        else:
            reasons = [reason("freeShape", {"type": field.get("originalType") or ""})]
        confidence = "review" if kind == "free" and shape["unknown"] else "exact"
        return decision("embed", confidence, reasons, ["embed"])
    target = shape["target"]
    options = ["embed", "reference"]
    declared = declared_relation(field)
    # `User.posts` next to `Post.author`: each post already says its user, so the list is read from there
    if kind == "models" and target != model["name"] and has_key(context, target) and declared != "embedded":
        back = back_reference(context, model["name"], target)
        if back:
            return decision(
                "child", "high", [reason("backReference", {"model": target, "field": back})], [*options, "child"]
            )
    if reaches(context, target, model["name"]):
        confidence = "exact" if target == model["name"] else "high"
        return decision("reference", confidence, [reason("recursiveEmbed", {"model": target})], options)
    if declared in ("embedded", "elementCollection") or declares_embeddable(find_model(context["schema"], target)):
        return decision("embed", "exact", [reason("relationDeclared")], options)
    if not has_key(context, target):
        return decision("embed", "high", [reason("valueObject", {"model": target})], options)
    others = other_usages(context, target, model["name"], field["name"])
    if others or is_top_level(context, target):
        users = ", ".join(usage["from"] for usage in others)
        return decision("reference", "review", [reason("sharedTarget", {"model": target, "users": users})], options)
    code = "unboundedList" if kind == "models" else "ownedList"
    return decision("embed", "probable", [reason(code, {"model": target})], options)


STRATEGY = {
    "target": "document",
    "surrogate_keys": SURROGATE_KEYS,
    "key_without_field": key_without_field,
    "relation": relation,
    "foreign_keys": False,
    "whole_numbers": False,
    "enum": lambda _name: None,
}
