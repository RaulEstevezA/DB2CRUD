"""Facts about a model schema that every proposal reads. Mirrors web/src/core/design/analysis.ts."""

from ..model.naming import name_words, singularize
from ..model.schema import all_fields, find_model, model_of
from .hints import declares_key


def analyze(schema: dict) -> dict:
    usages: dict[str, list[dict]] = {}
    parents: set[str] = set()
    for model in schema["models"]:
        for parent in model.get("extends") or []:
            parents.add(parent)
        for field in model["fields"]:
            target = model_of(field["type"])
            if not target or not find_model(schema, target):
                continue
            usages.setdefault(target, []).append(
                {"from": model["name"], "field": field["name"], "many": field["type"]["kind"] != "model"}
            )
    return {"schema": schema, "usages": usages, "parents": parents}


def is_top_level(context: dict, model: str) -> bool:
    return all(usage["from"] == model for usage in context["usages"].get(model, []))


def is_parent_only(context: dict, model: str) -> bool:
    return model in context["parents"] and is_top_level(context, model)


def other_usages(context: dict, target: str, origin: str, field: str) -> list[dict]:
    return [
        usage
        for usage in context["usages"].get(target, [])
        if not (usage["from"] == origin and usage["field"] == field)
    ]


# ---------- Keys ----------

_KEY_TYPES = {"integer", "uuid", "string"}


def keyable(field: dict) -> bool:
    """A non-null integer, UUID or text; a number without a size counts as an integer."""
    type_ref = field["type"]
    if type_ref["kind"] != "primitive" or field.get("nullable"):
        return False
    return type_ref["name"] in _KEY_TYPES or (type_ref["name"] == "float" and type_ref.get("bits") is None)


def _named_key(model: dict, field: dict) -> bool:
    words = name_words(field["name"])
    if len(words) == 1 and words[0] in ("id", "uuid"):
        return True
    model_words = name_words(model["name"])
    return len(words) == len(model_words) + 1 and words[-1] == "id" and words[: len(model_words)] == model_words


_NATURAL_KEYS = {"code", "sku", "slug", "key", "isbn", "username", "email", "number", "reference", "handle"}


def natural_key(model: dict, field: dict) -> bool:
    words = name_words(field["name"])
    if not words or words[-1] not in _NATURAL_KEYS:
        return False
    if len(words) == 1:
        return True
    model_words = name_words(model["name"])
    return len(words) == len(model_words) + 1 and words[: len(model_words)] == model_words


def key_field(model: dict, fields: list[dict]) -> dict | None:
    declared = next((field for field in fields if declares_key(field)), None)
    if declared:
        return {"field": declared, "declared": True}
    named = next((field for field in fields if _named_key(model, field) and keyable(field)), None)
    return {"field": named, "declared": False} if named else None


def has_key(context: dict, name: str) -> bool:
    model = find_model(context["schema"], name)
    return model is not None and key_field(model, all_fields(context["schema"], model)) is not None


# ---------- Shapes of fields ----------


def shape_of(context: dict, type_ref: dict) -> dict | None:
    schema = context["schema"]
    kind = type_ref["kind"]
    if kind == "model":
        return (
            {"kind": "model", "target": type_ref["name"]}
            if find_model(schema, type_ref["name"])
            else {"kind": "free", "unknown": True}
        )
    if kind == "unknown":
        return {"kind": "free", "unknown": True}
    if kind == "primitive":
        return {"kind": "free", "unknown": False} if type_ref["name"] == "any" else None
    if kind == "enum":
        return None
    if kind == "map":
        return {"kind": "map", "plain": type_ref["value"]["kind"] in ("primitive", "enum")}
    items = type_ref["items"]
    if items["kind"] == "model" and find_model(schema, items["name"]):
        return {"kind": "models", "target": items["name"]}
    if items["kind"] in ("primitive", "enum"):
        if items["kind"] == "primitive" and items["name"] == "any":
            return {"kind": "free", "unknown": False}
        return {"kind": "values"}
    return {"kind": "free", "unknown": items["kind"] == "unknown"}


def flattenable(context: dict, name: str, seen: set[str] | None = None) -> bool:
    seen = set() if seen is None else seen
    if name in seen:
        return False
    seen.add(name)
    model = find_model(context["schema"], name)
    if not model:
        return False
    for field in all_fields(context["schema"], model):
        type_ref = field["type"]
        if type_ref["kind"] == "primitive":
            if type_ref["name"] == "any":
                return False
        elif type_ref["kind"] == "enum":
            continue
        elif type_ref["kind"] == "model":
            if not flattenable(context, type_ref["name"], seen):
                return False
        else:
            return False
    return True


def reaches(context: dict, origin: str, to: str, seen: set[str] | None = None) -> bool:
    seen = set() if seen is None else seen
    if origin == to:
        return True
    if origin in seen:
        return False
    seen.add(origin)
    model = find_model(context["schema"], origin)
    if not model:
        return False
    for field in all_fields(context["schema"], model):
        following = model_of(field["type"])
        if following is not None and reaches(context, following, to, seen):
            return True
    return False


def back_reference(context: dict, owner: str, child: str) -> str | None:
    model = find_model(context["schema"], child)
    if not model:
        return None
    owner_words = "".join(name_words(owner))
    for field in all_fields(context["schema"], model):
        if field["type"]["kind"] == "model" and field["type"]["name"] == owner:
            return field["name"]
        words = name_words(field["name"])
        if len(words) >= 2 and words[-1] == "id" and "".join(words[:-1]) == owner_words:
            return field["name"]
    return None


def lists_back(context: dict, owner: str, child: str) -> str | None:
    model = find_model(context["schema"], child)
    if not model:
        return None
    for field in all_fields(context["schema"], model):
        if field["type"]["kind"] == "array" and model_of(field["type"]) == owner:
            return field["name"]
    return None


def singular_field(field: str) -> str:
    words = name_words(field)
    if not words:
        return field
    words[-1] = singularize(words[-1])
    return "_".join(words)
