"""Reads Tortoise ORM models (see field_models.py): tables named by `Meta.table` or by the model in lower case, an
integer `id` when a model declares no key, integer keys the database numbers unless `generated=False`, foreign keys
deleted with their rows unless they say otherwise and indexed only when they ask, and the table of a many-to-many field
(`through`, or `<table>_<other table>`) keyed by its two columns. `CharEnumField` and `IntEnumField` keep their values
in the application: the rules read them as an enum with a CHECK. Mirrors web/src/core/importers/orm/tortoise.ts."""

import re

from ...js import js_string
from ...model.naming import to_snake_case
from .expressions import boolean_of, name_of, number_of, string_of, text_of
from .field_models import FieldFlavour, link_table, read_field_models
from .types import OrmReader

_INTEGERS = {"SmallIntField": 16, "IntField": 32, "BigIntField": 64}


def _type_of(field: dict, enums: dict) -> dict | None:
    """The type of a Tortoise field, with the enum of an enum field."""
    name = name_of(field) or ""
    named = field["named"]
    sql = text_of(field)
    if name in _INTEGERS:
        return {"type": {"sql": sql, "kind": "integer", "bits": _INTEGERS[name]}}
    simple = {
        "FloatField": {"sql": sql, "kind": "float", "bits": 64},
        "TextField": {"sql": sql, "kind": "text"},
        "BooleanField": {"sql": sql, "kind": "boolean"},
        "DateField": {"sql": sql, "kind": "date"},
        # Tortoise keeps times in UTC with their zone
        "DatetimeField": {"sql": sql, "kind": "datetime", "timezone": True},
        "TimeField": {"sql": sql, "kind": "time", "timezone": False},
        "UUIDField": {"sql": sql, "kind": "uuid"},
        "BinaryField": {"sql": sql, "kind": "binary"},
        "JSONField": {"sql": sql, "kind": "json"},
    }
    if name in simple:
        return {"type": simple[name]}
    if name == "CharField":
        length = number_of(named.get("max_length"))
        return {"type": {"sql": sql, "kind": "text", **({"length": length} if length is not None else {})}}
    if name == "DecimalField":
        precision = number_of(named.get("max_digits"))
        scale = number_of(named.get("decimal_places"))
        return {
            "type": {
                "sql": sql,
                "kind": "decimal",
                **({"precision": precision} if precision is not None else {}),
                **({"scale": scale} if scale is not None else {}),
            }
        }
    if name in ("CharEnumField", "IntEnumField"):
        reference = field["args"][0] if field["args"] else named.get("enum_type")
        enum_class = enums.get(reference["path"][-1]) if reference is not None and reference["kind"] == "name" else None
        values = [js_string(member["value"]) for member in enum_class["members"]] if enum_class else []
        item = {"name": to_snake_case(enum_class["name"]), "values": values, "storage": "check"} if enum_class else None
        extra = {"enum": item} if item else {}
        if name == "IntEnumField":
            return {"type": {"sql": sql, "kind": "integer", "bits": 16}, **extra}
        # Without a length, Tortoise makes the column as long as the longest value
        length = number_of(named.get("max_length")) or max([1, *(len(value) for value in values)])
        return {"type": {"sql": sql, "kind": "text", "length": length}, **extra}
    return None


def _implicit_key() -> dict:
    return {
        "name": "id",
        "type": {"sql": "fields.IntField(primary_key=True)", "kind": "integer", "bits": 32},
        "nullable": False,
        "generated": "identity",
    }


def _join_table(model: dict, target: dict, relation: dict, models: list) -> dict | None:
    named = relation["named"]
    through = string_of(named.get("through"))
    name = through if through is not None else f"{model['table']['name']}_{target['table']['name']}"
    # A model that maps the table reads it as any other
    if any(item["table"]["name"] == name for item in models):
        return None
    backward = string_of(named.get("backward_key"))
    forward = string_of(named.get("forward_key"))
    backward = backward if backward is not None else f"{model['def']['name'].lower()}_id"
    forward = forward if forward is not None else f"{target['def']['name'].lower()}_id"
    table = link_table(name, model["def"]["line"], [(backward, model), (forward, target)])
    table["primaryKey"] = [backward, forward]
    return table


_TORTOISE = FieldFlavour(
    format="tortoise",
    type_of=_type_of,
    # Tortoise numbers an integer key unless told not to
    identity=lambda _kind, named, column_type, primary_key: (
        primary_key
        and column_type is not None
        and column_type["kind"] == "integer"
        and boolean_of(named.get("generated")) is not False
    ),
    positive=lambda _kind: False,
    foreign_key="ForeignKeyField",
    one_to_one="OneToOneField",
    many_to_many="ManyToManyField",
    options={"column": "source_field", "comment": "description", "table": "table", "tableComment": "table_description"},
    default_table=lambda definition: definition["name"].lower(),
    implicit_key=_implicit_key,
    on_delete="cascade",
    indexes_keys=False,
    join_table=_join_table,
)


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if re.search(r"\b(from|import)\s+tortoise\b", text) else 0


TORTOISE_READER = OrmReader(
    id="tortoise",
    label="Tortoise ORM",
    language="python",
    detect=_detect,
    read=lambda files: read_field_models(files, _TORTOISE),
)
