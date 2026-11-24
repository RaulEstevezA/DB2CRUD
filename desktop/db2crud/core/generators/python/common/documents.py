"""Nested documents in a Python project: a TypedDict per nested document, beside the entity that holds it;
`app/documents.py`, which checks them against their rules; and the items of lists that operations add and remove one by
one. Only strategies of document databases (orm["documents"]) have them. Mirrors
web/src/core/generators/python/common/documents.ts.

A nested type is {"name", "fields"}, each field {"column", "nested"}; a list info {"column", "item", "type",
"itemColumn", "by"}."""

import re
from collections.abc import Callable

from ....js import number_text
from ....model.naming import singularize, split_words
from ....schema.documents import item_key, nested_fields
from ...types import lines
from ..python import Imports, class_name, js_json, method_name, py_literal


def _nested_type(column: dict, parent: str, taken: set[str]) -> dict | None:
    fields = nested_fields(column["type"])
    if fields is None:
        return None
    words = split_words(column["name"])
    last = words[-1] if words else column["name"]
    if column["type"]["kind"] == "array":
        last = singularize(last)
    name = parent + class_name(" ".join([*words[:-1], last]))
    while name in taken:
        name += "Value"
    taken.add(name)
    return {
        "name": name,
        "fields": [{"column": field, "nested": _nested_type(field, name, taken)} for field in fields],
    }


def nested_types(columns: list[dict], entity: str) -> dict[str, dict]:
    """The types of the nested documents of a collection, by column."""
    taken = {entity}
    result = {}
    for column in columns:
        nested = _nested_type(column, entity, taken)
        if nested:
            result[column["name"]] = nested
    return result


def inner_first(nested: dict) -> list[dict]:
    """A nested type and those inside it, the innermost first."""
    return [
        *(inner for field in nested["fields"] if field["nested"] for inner in inner_first(field["nested"])),
        nested,
    ]


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
            result.append(f'"values": [{", ".join(py_literal(value) for value in parsed["values"])}]')
            continue
        value = number_text(parsed["value"])
        if parsed["kind"] == "compare":
            result.append(f'"{_LIMITS[parsed["op"]]}": {value}')
        elif parsed["op"] == ">=":
            result.append(f'"min_length": {value}')
        elif parsed["op"] == "<=":
            result.append(f'"max_length": {value}')
    return result


def _braces(items: list[str]) -> str:
    return "{" + ", ".join(items) + "}"


def _type_rule(schema: dict, column_type: dict) -> list[str]:
    kind = column_type["kind"]
    if kind == "array":
        return [f'"items": {_braces(_type_rule(schema, column_type["items"]))}']
    if kind == "json" and column_type.get("fields") is not None:
        fields = [
            f"{js_json(field['name'])}: {_field_rule(schema, field)}"
            for field in column_type["fields"]
            if field["name"] != "_id"
        ]
        return [f'"fields": {_braces(fields)}']
    if kind == "enum":
        item = next((item for item in schema["enums"] if item["name"] == column_type["name"]), None)
        return [f'"values": [{", ".join(py_literal(value) for value in item["values"]) if item else ""}]']
    if kind == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        return [f'"max_length": {column_type["length"]}']
    return []


def _field_rule(schema: dict, field: dict) -> str:
    required = [] if field["nullable"] or field.get("default") else ['"required": True']
    return _braces([*required, *_type_rule(schema, field["type"]), *_limits(field.get("checks") or [])])


def document_rules(context: dict, info: dict) -> list[dict]:
    """The columns that hold documents, or lists, with the rule of each."""
    if not context["orm"].get("documents"):
        return []
    result = []
    for column in info["columns"]:
        column_type = column["column"]["type"]
        if column_type["kind"] == "array" or (column_type["kind"] == "json" and column_type.get("fields") is not None):
            result.append({"column": column, "rule": _braces(_type_rule(context["schema"], column_type))})
    return result


def has_rules(context: dict, info: dict, column: dict) -> bool:
    return any(item["column"] is column for item in document_rules(context, info))


def identified_lists(info: dict) -> list[dict]:
    """The lists of a collection whose documents have an identifier, which is made before they are stored."""
    return [
        column
        for column in info["columns"]
        if column["column"]["type"]["kind"] == "array" and item_key(column["column"]["type"]["items"]) == "id"
    ]


def documents_file(context: dict) -> dict | None:
    if not context["orm"].get("documents"):
        return None
    imports = Imports().from_("typing", "Any").from_("bson", "ObjectId").from_("app.errors", "FieldError")
    return {
        "path": "app/documents.py",
        "content": lines(
            '"""The documents inside others: their rules, what does not follow them, and the identifiers of those in lists."""',
            "",
            imports.write("app"),
            "",
            "type Rule = dict[str, Any]",
            '"""What a value must be: the fields of a document, the items of a list, the values or limits of anything else."""',
            "",
            "",
            "def problems(value: Any, rule: Rule, path: str) -> list[FieldError]:",
            '    """What a value does not follow of its rule, each with the path of its field (`lines.0.quantity`). Fields the rules do not name are left alone."""',
            "    if value is None:",
            '        return [FieldError(path, "is required")] if rule.get("required") else []',
            "    errors: list[FieldError] = []",
            '    if "items" in rule:',
            "        if not isinstance(value, list):",
            '            return [FieldError(path, "must be a list")]',
            "        for index, item in enumerate(value):",
            '            errors += problems(item, rule["items"] | {"required": True}, f"{path}.{index}")',
            '    if "fields" in rule:',
            "        if not isinstance(value, dict):",
            '            return [FieldError(path, "must be a document")]',
            '        for name, field in rule["fields"].items():',
            '            errors += problems(value.get(name), field, f"{path}.{name}")',
            '    if "values" in rule and value not in rule["values"]:',
            '        errors.append(FieldError(path, "must be one of: " + ", ".join(str(item) for item in rule["values"])))',
            '    if "min" in rule and value < rule["min"]:',
            "        errors.append(FieldError(path, f\"must be >= {rule['min']}\"))",
            '    if "above" in rule and value <= rule["above"]:',
            "        errors.append(FieldError(path, f\"must be > {rule['above']}\"))",
            '    if "max" in rule and value > rule["max"]:',
            "        errors.append(FieldError(path, f\"must be <= {rule['max']}\"))",
            '    if "below" in rule and value >= rule["below"]:',
            "        errors.append(FieldError(path, f\"must be < {rule['below']}\"))",
            '    if "min_length" in rule and len(value) < rule["min_length"]:',
            "        errors.append(FieldError(path, f\"must have >= {rule['min_length']} characters\"))",
            '    if "max_length" in rule and len(value) > rule["max_length"]:',
            "        errors.append(FieldError(path, f\"is longer than {rule['max_length']} characters\"))",
            "    return errors",
            "",
            "",
            "def identify(items: list[Any] | None) -> None:",
            '    """Gives an identifier to the documents of a list that have none: MongoDB numbers only whole documents."""',
            "    for item in items or []:",
            '        if item.get("_id") is None:',
            '            item["_id"] = str(ObjectId())',
            "",
        ),
    }


# Items of lists


def list_of(info: dict, query: dict) -> dict:
    """A list of a collection whose items are added and removed one by one."""
    column = next(item for item in info["columns"] if item["column"]["name"] == query["columns"][0])
    item_type = column["column"]["type"]["items"]
    # The name of the item is that of the operation: `addLine` adds a `line`
    name = method_name(re.sub(r"^(add|remove)", "", query["name"]))
    item = f"{name}_item" if any(other["attr"] == name for other in info["key"]) else name
    return {
        "column": column,
        "item": item,
        "type": item_type,
        # The column of one item, for its Python type
        "itemColumn": {**column, "column": {**column["column"], "type": item_type}},
        # How an item is told from the others: its `_id`, its value or its position
        "by": item_key(item_type),
    }


def item_params(items: dict, type_of: Callable[[dict], str]) -> list[dict]:
    """The parameters that say which item to remove."""
    if items["by"] == "id":
        return [{"name": f"{items['item']}_id", "type": "str"}]
    if items["by"] == "value":
        return [{"name": items["item"], "type": type_of(items["itemColumn"])}]
    return [{"name": "position", "type": "int"}]
