"""Wide columns (Cassandra, ScyllaDB): a table per stored model, partitioned by its key. There are no joins: values
live inside the row (user-defined types, collections) and a list of other models is a table of its own,
partitioned by the owner's key, so it is read with one query. Which tables to keep depends on the queries, which
the model does not say: lists of other models wait for the user. Mirrors web/src/core/design/targets/wideColumn.ts."""

from ...model.schema import find_model
from ..analysis import flattenable, has_key, keyable, natural_key, reaches
from ..decision import decision, reason
from ..hints import declared_relation, declares_embeddable

# No auto-increment: a new key is a UUID
SURROGATE_KEYS = [{"kind": "surrogate", "type": "uuid"}]


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
        recursive = reaches(context, target, model["name"])
        options = [
            "reference",
            *([] if recursive else ["embed"]),
            *(["flatten"] if flattenable(context, target) else []),
            "json",
        ]
        if target == model["name"]:
            return decision("reference", "exact", [reason("selfReference")], options)
        if declared == "embedded" or declares_embeddable(find_model(context["schema"], target)):
            return decision("json" if recursive else "embed", "exact", [reason("relationDeclared")], options)
        if has_key(context, target):
            return decision("reference", "high", [reason("targetHasKey", {"model": target})], options)
        if recursive:
            return decision("json", "probable", [reason("recursiveEmbed", {"model": target})], options)
        return decision("embed", "probable", [reason("valueType", {"model": target})], options)
    if kind == "models":
        target = shape["target"]
        recursive = reaches(context, target, model["name"])
        options = ["child", *([] if recursive else ["embed"]), "json"]
        if has_key(context, target):
            return decision("child", "review", [reason("partitionTable", {"model": target})], options)
        if recursive:
            return decision("json", "review", [reason("recursiveEmbed", {"model": target})], options)
        return decision("embed", "review", [reason("embeddedList", {"model": target})], options)
    if kind == "values":
        return decision("array", "high", [reason("nativeCollection")], ["array", "json"])
    if kind == "map":
        if shape["plain"]:
            return decision("array", "high", [reason("nativeCollection")], ["array", "json"])
        return decision("json", "probable", [reason("mapOfValues")], ["json"])
    confidence = "review" if shape["unknown"] else "probable"
    return decision("json", confidence, [reason("freeShape", {"type": field.get("originalType") or ""})], ["json"])


STRATEGY = {
    "target": "widecolumn",
    "surrogate_keys": SURROGATE_KEYS,
    "key_without_field": key_without_field,
    "relation": relation,
    # No foreign keys: a column holding another model's key is a plain column
    "foreign_keys": False,
    "whole_numbers": False,
    "enum": lambda name: None,
}
