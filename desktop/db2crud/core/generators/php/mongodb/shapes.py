"""The shape of the documents of a collection, as the constant `App\\Documents` converts values with: what each field is
in MongoDB when PHP has another type for it (an identifier or an exact number is a text, a moment a DateTimeImmutable).
Mirrors web/src/core/generators/php/mongodb/shapes.ts."""

from ....schema.documents import is_object_id
from ..common.php import php_string


def shape_of(column_type: dict) -> str | None:
    """The shape of a value as a PHP literal, or None for one that is stored as it is."""
    kind = column_type["kind"]
    if is_object_id(column_type):
        return "'objectId'"
    if kind in ("decimal", "uuid", "datetime", "binary"):
        return f"'{kind}'"
    if kind == "integer":
        return "'long'" if column_type["bits"] == 64 else "'int'"
    if kind == "float":
        return "'double'"
    if kind == "array":
        items = shape_of(column_type["items"])
        return None if items is None else f"['items' => {items}]"
    if kind == "json" and column_type.get("fields") is not None:
        fields = ", ".join(
            f"{php_string(field['name'])} => {shape_of(field['type']) or 'null'}" for field in column_type["fields"]
        )
        return f"['fields' => [{fields}]]"
    return None


def stored(column_type: dict, value: str) -> str:
    """A value as MongoDB stores it."""
    shape = shape_of(column_type)
    return value if shape is None else f"Documents::toBson({value}, {shape})"


def shape_lines(info: dict) -> list[str]:
    """The shape of every field of a collection, by its stored name."""
    return [
        "    private const SHAPE = [",
        *(
            f"        {php_string(column['column']['name'])} => {shape_of(column['column']['type']) or 'null'},"
            for column in info["columns"]
        ),
        "    ];",
    ]
