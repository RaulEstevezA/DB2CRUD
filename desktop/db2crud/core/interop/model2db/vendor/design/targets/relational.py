"""Tables: references become foreign keys, value objects columns, lists child or join tables. Mirrors
web/src/core/design/targets/relational.ts."""

from ...model.schema import find_model
from ..analysis import back_reference, flattenable, has_key, keyable, lists_back, natural_key, other_usages
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
        target_model = find_model(context["schema"], target)
        if declared == "embedded" or declares_embeddable(target_model):
            return decision(
                "flatten" if "flatten" in options else "json", "exact", [reason("relationDeclared")], options
            )
        if declared in ("manyToOne", "oneToOne"):
            return decision("reference", "exact", [reason("relationDeclared")], options)
        if target == model["name"]:
            return decision("reference", "exact", [reason("selfReference")], options)
        if has_key(context, target):
            return decision("reference", "high", [reason("targetHasKey", {"model": target})], options)
        if "flatten" in options:
            return decision("flatten", "probable", [reason("valueObject", {"model": target})], options)
        return decision("reference", "review", [reason("notFlattenable", {"model": target})], options)
    if kind == "models":
        target = shape["target"]
        options = ["child", "join", "json"]
        if declared in ("oneToMany", "elementCollection"):
            return decision("child", "exact", [reason("relationDeclared")], options)
        if declared == "manyToMany":
            return decision("join", "exact", [reason("relationDeclared")], options)
        if target == model["name"]:
            return decision("child", "high", [reason("selfReference")], options)
        back = back_reference(context, model["name"], target)
        if back:
            return decision("child", "high", [reason("backReference", {"model": target, "field": back})], options)
        mirror = lists_back(context, model["name"], target)
        if mirror:
            return decision("join", "high", [reason("bothSidesLists", {"model": target, "field": mirror})], options)
        others = other_usages(context, target, model["name"], field["name"])
        if others and has_key(context, target):
            users = ", ".join(usage["from"] for usage in others)
            return decision("join", "review", [reason("sharedTarget", {"model": target, "users": users})], options)
        confidence = "probable" if has_key(context, target) else "high"
        return decision("child", confidence, [reason("ownedList", {"model": target})], options)
    if kind == "values":
        options = ["child", "array", "json"]
        if declared == "elementCollection":
            return decision("child", "exact", [reason("relationDeclared")], options)
        return decision("child", "probable", [reason("primitiveList")], options)
    if kind == "map":
        options = ["json", "child"] if shape["plain"] else ["json"]
        return decision("json", "high", [reason("mapOfValues")], options)
    confidence = "review" if shape["unknown"] else "probable"
    return decision("json", confidence, [reason("freeShape", {"type": field.get("originalType") or ""})], ["json"])


def enum(name: str) -> dict:
    storage = decision("check", "high", [reason("enumCheck")], ["check", "native", "lookup", "text"])
    return {"enum": name, "storage": storage}


STRATEGY = {
    "target": "relational",
    "surrogate_keys": SURROGATE_KEYS,
    "key_without_field": key_without_field,
    "relation": relation,
    "foreign_keys": True,
    "whole_numbers": True,
    "enum": enum,
}
