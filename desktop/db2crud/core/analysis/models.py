"""Facts about each model: whether the input declares it as a stored entity, which field identifies it, and which
other models refer to it. Only what the input says or what follows from its names is reported; the rules that build
on them decide what to do with it. Mirrors web/src/core/analysis/models.ts.

The facts of a model are a dictionary: {"model", "declaredEntity", "declaredKey", "declaredKeyGenerated",
"namedKey", "keyCandidates", "referencedBy": [{"model", "field", "many"}]}.
"""

import re

from ..model.naming import name_words
from ..model.schema import FieldDef, ModelDef, ModelSchema, TypeRef, all_fields, find_model

# Frameworks whose models are stored entities, as the importers name them
_ENTITY_FRAMEWORKS = {"jpa", "efcore", "doctrine", "django", "sqlalchemy", "sqlmodel", "typeorm", "prisma"}

# Annotations that mark a stored entity (@Entity, @Table, @Document)
_ENTITY_ANNOTATIONS = {"entity", "table", "document"}

# Annotations that mark a key field, by simple lower-case name
_KEY_ANNOTATIONS = {
    "id",
    "key",
    "primarykey",
    "primarycolumn",
    "primarygeneratedcolumn",
    "objectidcolumn",
    "embeddedid",
}

# Annotations that say the server fills the key (@GeneratedValue, @default(autoincrement()))
_GENERATED_KEY_ANNOTATIONS = {"generatedvalue", "primarygeneratedcolumn", "databasegenerated", "uuidgenerator"}

_SEPARATORS = re.compile(r"\.|::|\\")
_ATTRIBUTE = re.compile(r"Attribute$")
_GENERATING_DEFAULT = re.compile(r"^\s*(autoincrement|uuid|cuid)\(")


def _simple_name(name: str) -> str:
    return _ATTRIBUTE.sub("", _SEPARATORS.split(name)[-1], count=1).lower()


def _annotation_names(item: dict) -> set[str]:
    return {_simple_name(annotation["name"]) for annotation in item.get("annotations") or []}


def _arg_is_true(annotation: dict, name: str) -> bool:
    """primary_key=True, primary: true and the like inside an annotation's arguments."""
    pattern = rf"(?:^|[\s,({{]){name}\s*[:=]\s*(true|True)\b"
    return re.search(pattern, annotation.get("args") or "", re.ASCII) is not None


def declares_key(field: FieldDef) -> bool:
    """The input declares the field as the key of its model."""
    if (field.get("metadata") or {}).get("primaryKey") is True:
        return True
    if _annotation_names(field) & _KEY_ANNOTATIONS:
        return True
    return any(
        _arg_is_true(annotation, "primary_key") or _arg_is_true(annotation, "primary")
        for annotation in field.get("annotations") or []
    )


def _declares_generated_key(field: FieldDef) -> bool:
    """The input says the server fills the key."""
    if field.get("generated"):
        return True
    if _annotation_names(field) & _GENERATED_KEY_ANNOTATIONS:
        return True
    return any(
        _simple_name(annotation["name"]) == "default" and _GENERATING_DEFAULT.match(annotation.get("args") or "")
        for annotation in field.get("annotations") or []
    )


def model_target(type_ref: TypeRef) -> dict | None:
    """The model a type leads to, directly or through a list, and whether it is a list: {"model", "many"}."""
    if type_ref["kind"] == "model":
        return {"model": type_ref["name"], "many": False}
    if type_ref["kind"] == "array" and type_ref["items"]["kind"] == "model":
        return {"model": type_ref["items"]["name"], "many": True}
    return None


def _can_be_key(field: FieldDef) -> bool:
    """A required single value that can identify something: text, whole number or UUID."""
    if field.get("optional") or field["type"]["kind"] != "primitive":
        return False
    return field["type"]["name"] in ("string", "integer", "uuid")


def _named_key(model: ModelDef, fields: list[FieldDef]) -> str | None:
    plain = next(
        (field for field in fields if field["name"].lower() == "id" and field["type"]["kind"] == "primitive"), None
    )
    if plain:
        return plain["name"]
    own = {f"{model['name']}id".lower(), f"{model['name']}_id".lower()}
    return next(
        (field["name"] for field in fields if field["name"].lower() in own and field["type"]["kind"] == "primitive"),
        None,
    )


def _is_entity(model: ModelDef) -> bool:
    if model.get("framework") and model["framework"] in _ENTITY_FRAMEWORKS:
        return True
    return bool(_annotation_names(model) & _ENTITY_ANNOTATIONS)


def analyze_models(schema: ModelSchema) -> dict[str, dict]:
    """The facts of every model of a schema, by name, in the order of the schema."""
    facts: dict[str, dict] = {}
    for model in schema["models"]:
        fields = all_fields(schema, model)
        declared = next((field for field in fields if declares_key(field)), None)
        facts[model["name"]] = {
            "model": model["name"],
            "declaredEntity": _is_entity(model),
            "declaredKey": declared["name"] if declared else None,
            "declaredKeyGenerated": _declares_generated_key(declared) if declared else False,
            "namedKey": _named_key(model, fields),
            "keyCandidates": [field["name"] for field in fields if _can_be_key(field)],
            "referencedBy": [],
        }
    for model in schema["models"]:
        for field in all_fields(schema, model):
            target = model_target(field["type"])
            if target and find_model(schema, target["model"]):
                facts[target["model"]]["referencedBy"].append(
                    {"model": model["name"], "field": field["name"], "many": target["many"]}
                )
    return facts


# Words that say a field holds a secret the API must never return
_SECRET_WORDS = {"password", "passwd", "secret", "pin", "token", "apikey"}


def is_secret_name(name: str) -> bool:
    """A name whose words say it holds a secret: password, passwordHash, api_key, refreshToken."""
    words = [word.lower() for word in name_words(name)]
    return any(word in _SECRET_WORDS for word in words) or "".join(words).endswith("apikey")


_CREATED = re.compile(r"^(created|creation|inserted)(at|on|date|time)?$")
_UPDATED = re.compile(r"^(updated|modified|lastmodified|changed)(at|on|date|time)?$")


def audit_kind(name: str) -> str | None:
    """Names of timestamps the server keeps: createdAt, updated_at, modifiedOn, deletedAt → created / updated."""
    lower = name.lower().replace("_", "")
    if _CREATED.match(lower):
        return "created"
    if _UPDATED.match(lower):
        return "updated"
    return None
