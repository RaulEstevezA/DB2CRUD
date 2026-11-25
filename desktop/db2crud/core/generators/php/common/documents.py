"""Nested documents in a PHP project: arrays by the stored names of their fields, checked against their rules
(`App\\Documents`), and the items of lists that operations add and remove one by one. Only strategies of document
databases (orm["documents"]) have them. Mirrors web/src/core/generators/php/common/documents.ts.

A list info is {"column", "item", "php", "type", "by", "params"}."""

import re

from ....js import number_text
from ....schema.documents import item_key, nested_fields
from .context import column_of
from .php import field_name, php_literal, php_string


def _brackets(items: list[str]) -> str:
    return f"[{', '.join(items)}]"


def doc_type_of(context: dict, column_type: dict) -> str:
    """The type of a value as PHPDoc writes it: `list<array{sku: string, status?: string|null}>`."""
    if column_type["kind"] == "array":
        return f"list<{doc_type_of(context, column_type['items'])}>"
    if column_type["kind"] == "json" and column_type.get("fields") is not None:
        fields = []
        for field in column_type["fields"]:
            optional = field["nullable"] or "default" in field
            name = field["name"] if re.match(r"^[A-Za-z_]\w*$", field["name"], re.ASCII) else php_string(field["name"])
            inner = doc_type_of(context, field["type"])
            null = "|null" if optional and inner != "mixed" else ""
            fields.append(f"{name}{'?' if optional else ''}: {inner}{null}")
        return f"array{{{', '.join([*fields, '...'])}}}"
    return context["orm"]["phpType"](column_type)


# Rules

_LIMITS = {">=": "min", ">": "above", "<=": "max", "<": "below"}


def _limits(checks: list[dict]) -> list[str]:
    """The limits of the CHECKs of a field, as settings of its rule."""
    result = []
    for check in checks:
        parsed = check.get("parsed")
        if not parsed:
            continue
        if parsed["kind"] == "in":
            result.append(f"'values' => {_brackets([php_literal(value) for value in parsed['values']])}")
        elif parsed["kind"] == "compare":
            result.append(f"'{_LIMITS[parsed['op']]}' => {number_text(parsed['value'])}")
        elif parsed["op"] == ">=":
            result.append(f"'minLength' => {number_text(parsed['value'])}")
        elif parsed["op"] == "<=":
            result.append(f"'maxLength' => {number_text(parsed['value'])}")
    return result


def _type_rule(schema: dict, column_type: dict) -> list[str]:
    kind = column_type["kind"]
    if kind == "array":
        return [f"'items' => {_brackets(_type_rule(schema, column_type['items']))}"]
    if kind == "json" and column_type.get("fields") is not None:
        fields = [
            f"{php_string(field['name'])} => {_field_rule(schema, field)}"
            for field in column_type["fields"]
            if field["name"] != "_id"
        ]
        return [f"'fields' => {_brackets(fields)}"]
    if kind == "enum":
        found = next((item for item in schema["enums"] if item["name"] == column_type["name"]), None)
        return [f"'values' => {_brackets([php_string(value) for value in (found['values'] if found else [])])}"]
    if kind == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        return [f"'maxLength' => {column_type['length']}"]
    return []


def _field_rule(schema: dict, field: dict) -> str:
    required = [] if field["nullable"] or field.get("default") else ["'required' => true"]
    return _brackets([*required, *_type_rule(schema, field["type"]), *_limits(field.get("checks") or [])])


def document_rule(context: dict, column_type: dict) -> str | None:
    """The rule of a column that holds documents or a list, as a PHP array; None for any other."""
    if not context["orm"].get("documents") or (column_type["kind"] != "array" and nested_fields(column_type) is None):
        return None
    return _brackets(_type_rule(context["schema"], column_type))


# Items of lists


def list_of(context: dict, info: dict, query: dict) -> dict:
    column = column_of(info, query["columns"][0])
    column_type = column["column"]["type"]["items"]
    name = field_name(re.sub(r"^(add|remove)", "", query["name"]))
    item = f"{name}Item" if any(other["field"] == name for other in info["key"]) else name
    php = context["orm"]["phpType"](column_type)
    by = item_key(column_type)
    if by == "id":
        params = [{"name": f"{item}Id", "type": "string"}]
    elif by == "value":
        params = [{"name": item, "type": php}]
    else:
        params = [{"name": "position", "type": "int"}]
    return {"column": column, "item": item, "php": php, "type": column_type, "by": by, "params": params}


def identified_lists(info: dict) -> list[dict]:
    """The lists of a collection whose documents have an identifier, which is made before they are stored."""
    return [
        column
        for column in info["columns"]
        if column["column"]["type"]["kind"] == "array" and item_key(column["column"]["type"]["items"]) == "id"
    ]
