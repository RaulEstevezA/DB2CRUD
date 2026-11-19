"""Reads Django models (see field_models.py): tables named by `Meta.db_table` or by the app and the model, a big
integer `id` when a model declares no key, every foreign key indexed, and many-to-many tables that Django creates
(`<table>_<field>`) unless a `through` model maps one. `TextChoices` and `IntegerChoices` are enums. Mirrors
web/src/core/importers/orm/django.ts."""

import re

from .expressions import name_of, number_of, text_of
from .field_models import FieldFlavour, link_table, read_field_models
from .types import OrmReader

# Types

# Text fields with the length Django gives them when none is said
_TEXT_LENGTHS = {
    "CharField": None,
    "SlugField": 50,
    "EmailField": 254,
    "URLField": 200,
    "GenericIPAddressField": 39,
    "IPAddressField": 15,
    "FilePathField": 100,
    "FileField": 100,
    "ImageField": 100,
}

_INTEGERS = {
    "AutoField": {"bits": 32, "identity": True},
    "BigAutoField": {"bits": 64, "identity": True},
    "SmallAutoField": {"bits": 16, "identity": True},
    "IntegerField": {"bits": 32},
    "BigIntegerField": {"bits": 64},
    "SmallIntegerField": {"bits": 16},
    "PositiveIntegerField": {"bits": 32, "positive": True},
    "PositiveBigIntegerField": {"bits": 64, "positive": True},
    "PositiveSmallIntegerField": {"bits": 16, "positive": True},
}


def _with_length(sql: str, kind: str, length) -> dict:
    return {"sql": sql, "kind": kind, **({"length": length} if length is not None else {})}


def _type_of(field: dict) -> dict | None:
    """The database type of a field, or None when it is not one the rules know."""
    name = name_of(field) or ""
    named = field["named"]
    sql = text_of(field)
    if name in _INTEGERS:
        return {"sql": sql, "kind": "integer", "bits": _INTEGERS[name]["bits"]}
    if name in _TEXT_LENGTHS:
        length = number_of(named.get("max_length"))
        return _with_length(sql, "text", length if length is not None else _TEXT_LENGTHS[name])
    if name == "TextField":
        return {"sql": sql, "kind": "text"}
    if name == "FloatField":
        return {"sql": sql, "kind": "float", "bits": 64}
    if name == "DecimalField":
        precision = number_of(named.get("max_digits"))
        scale = number_of(named.get("decimal_places"))
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": precision} if precision is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if name in ("BooleanField", "NullBooleanField"):
        return {"sql": sql, "kind": "boolean"}
    if name == "DateField":
        return {"sql": sql, "kind": "date"}
    # Django keeps times in UTC (USE_TZ, on by default since Django 5)
    if name == "DateTimeField":
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if name == "TimeField":
        return {"sql": sql, "kind": "time", "timezone": False}
    if name == "UUIDField":
        return {"sql": sql, "kind": "uuid"}
    if name == "BinaryField":
        return _with_length(sql, "binary", number_of(named.get("max_length")))
    if name == "JSONField":
        return {"sql": sql, "kind": "json"}
    if name == "ArrayField":
        base = field["args"][0] if field["args"] else named.get("base_field")
        items = _type_of(base) if base is not None and base["kind"] == "call" else None
        return {
            "sql": sql,
            "kind": "array",
            "items": items or {"sql": text_of(base) if base is not None else "", "kind": "unknown"},
        }
    return None


def _app_of(file: str) -> str | None:
    """The app a model belongs to, from where its file is: `shop/models.py` or `shop/models/order.py` → `shop`."""
    parts = [part for part in file.split("/") if part]
    models = len(parts) - 1 - parts[::-1].index("models") if "models" in parts else -1
    if models > 0:
        return parts[models - 1]
    return parts[-2] if len(parts) > 1 and parts[-1] == "models.py" else None


def _big_auto_id() -> dict:
    return {
        "name": "id",
        "type": {"sql": "models.BigAutoField()", "kind": "integer", "bits": 64},
        "nullable": False,
        "generated": "identity",
    }


def _default_table(definition: dict) -> str:
    app = _app_of(definition["file"])
    lower = definition["name"].lower()
    return f"{app}_{lower}" if app else lower


def _join_table(model: dict, target: dict, relation: dict, _models: list) -> dict | None:
    """Django's table for a many-to-many field: `<table>_<field>`, numbered, with a key to each side; a `through`
    model is a table of its own, read as any other model."""
    if "through" in relation["named"]:
        return None
    is_self = model is target
    source = f"{'from_' if is_self else ''}{model['def']['name'].lower()}_id"
    to = f"{'to_' if is_self else ''}{target['def']['name'].lower()}_id"
    table = link_table(
        f"{model['table']['name']}_{relation['attribute']}", model["def"]["line"], [(source, model), (to, target)]
    )
    table["columns"].insert(0, _big_auto_id())
    table["primaryKey"] = ["id"]
    table["uniques"].append({"columns": [source, to]})
    table["indexes"] += [{"columns": [source]}, {"columns": [to]}]
    return table


def _type_of_field(field: dict, _enums: dict) -> dict | None:
    column_type = _type_of(field)
    return {"type": column_type} if column_type else None


_DJANGO = FieldFlavour(
    format="django",
    type_of=_type_of_field,
    identity=lambda kind, _named, _type, _primary_key: _INTEGERS.get(kind, {}).get("identity") is True,
    positive=lambda kind: _INTEGERS.get(kind, {}).get("positive") is True,
    foreign_key="ForeignKey",
    one_to_one="OneToOneField",
    many_to_many="ManyToManyField",
    options={"column": "db_column", "comment": "db_comment", "table": "db_table", "tableComment": "db_table_comment"},
    default_table=_default_table,
    implicit_key=_big_auto_id,
    on_delete=None,
    indexes_keys=True,
    join_table=_join_table,
)


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    if not re.search(r"\bfrom\s+django\.db\s+import\s+models\b|\bdjango\.db\.models\b", text):
        return 0
    return 1 if re.search(r"\(\s*models\.Model\s*\)|models\.\w+Field\(", text) else 0.5


DJANGO_READER = OrmReader(
    id="django", label="Django", language="python", detect=_detect, read=lambda files: read_field_models(files, _DJANGO)
)
