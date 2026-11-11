"""Names and small facts the relational build needs; no state. Mirrors web/src/core/physical/relational/names.ts."""

from ...js import coalesce, js_string
from ...model.naming import name_words, to_pascal_case, to_snake_case
from ..naming import column_name, join_names

DEFAULT_LENGTH = 255


def field_column(field: dict, decided: dict | None, options: dict) -> str:
    """Column name of a field: the one the user wrote, the database name the input declares, or the field's."""
    return coalesce(
        (decided or {}).get("column"), field.get("serializedName"), column_name(field["name"], options["naming"])
    )


def stores_null(field: dict) -> bool:
    """A column accepts NULL when the field may be null, or may be missing without a value to put instead."""
    return bool(field["nullable"] or (field["optional"] and "defaultValue" not in field and not field.get("generated")))


def key_type(column_type: dict) -> dict:
    """A float without a size (TypeScript's `number`) used as a key is an integer."""
    if column_type["kind"] == "primitive" and column_type["name"] == "float" and column_type.get("bits") is None:
        return {"kind": "primitive", "name": "integer", "bits": 64}
    return column_type


def key_column_name(prefix: str, key: str, options: dict) -> str:
    """Name of a column holding another table's key: `customer` + `id` → `customer_id`; a key that already
    starts with the prefix is kept as it is (`customer` + `customer_id` → `customer_id`)."""
    prefix_words = name_words(prefix)
    key_words = name_words(key)
    if len(key_words) > len(prefix_words) and all(key_words[i] == word for i, word in enumerate(prefix_words)):
        return join_names([key], options["naming"])
    return join_names([prefix, key], options["naming"])


def owned_table_name(model: str, field: str, options: dict) -> str:
    """Table of a list or map owned by a model: `Order.tags` → `order_tags`."""
    if options["naming"]["tables"] == "model":
        return f"{model}{to_pascal_case(field)}"
    return f"{to_snake_case(model)}_{to_snake_case(field)}"


def enum_length(values: list) -> int:
    """Width of a text column holding enum values."""
    longest = max([1, *(len(js_string(value)) for value in values)])
    return 20 if longest <= 20 else 50 if longest <= 50 else DEFAULT_LENGTH
