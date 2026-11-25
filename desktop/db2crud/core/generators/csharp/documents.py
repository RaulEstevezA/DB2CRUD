"""Nested documents in a C# project: a class per nested document, inside the entity that holds it, the checks of their
rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
databases (orm["documents"]) have them. Mirrors web/src/core/generators/csharp/documents.ts.

A nested class is {"name", "path", "fields", "classes"}: `LineDocument`, `Order.LineDocument`, its fields and the classes
inside it. A nested field is {"column", "prop", "cs", "valueType", "optional", "propType", "nested"}. A list info is
{"column", "item", "cs", "type", "nested", "by", "params"}."""

import re

from ...js import number_text
from ...model.naming import singularize, split_words
from ...schema.documents import is_object_id, item_key, nested_fields
from . import context as csharp_context
from .csharp import cs_string, local_name, pascal_name

FREE = "MongoDB.Bson.BsonValue"
"""A value nothing says the shape of, as the driver has it."""


def _list_depth(column_type: dict) -> int:
    return 1 + _list_depth(column_type["items"]) if column_type["kind"] == "array" else 0


def _value_type(column_type: dict, nested: str | None) -> tuple[str, bool]:
    """The C# type of a value of a document, given the class of the documents it holds, and whether it is a value type."""
    kind = column_type["kind"]
    if kind == "array":
        return f"List<{_value_type(column_type['items'], nested)[0]}>", False
    if kind == "json":
        return (nested if column_type.get("fields") is not None else FREE), False
    if kind == "unknown":
        return FREE, False
    # MongoDB keeps moments in UTC
    if kind == "datetime":
        return "DateTime", True
    # MongoDB has no dates without a time and no times of the day: their text
    if kind in ("date", "time"):
        return "string", False
    return csharp_context.cs_type(column_type, "mongodb")


def _nested_class(column: dict, parent: str, taken: set[str], in_list: bool = False) -> dict | None:
    fields = nested_fields(column["type"])
    if fields is None:
        return None
    # In a list, at any depth: lists are written whole, so it carries the fields its class does not know
    listed = in_list or _list_depth(column["type"]) > 0
    words = split_words(column["name"])
    last = words[-1] if words else column["name"]
    if _list_depth(column["type"]) > 0:
        last = singularize(last)
    name = f"{pascal_name(' '.join([*words[:-1], last]))}Document"
    while name in taken:
        name += "Value"
    taken.add(name)
    path = f"{parent}.{name}"
    used = {name}
    props = []
    for field in fields:
        prop = "Id" if field["name"] == "_id" else pascal_name(field["name"])
        while prop in used:
            prop += "Value"
        used.add(prop)
        props.append(prop)
    # A class inside another has neither the name of one that encloses it nor that of a property beside it
    inside = taken | used
    classes: list[dict] = []
    written = []
    for field, prop in zip(fields, props, strict=True):
        nested = _nested_class(field, path, inside, listed)
        if nested:
            classes.append(nested)
        cs, value_type = _value_type(field["type"], nested["path"] if nested else None)
        optional = field["nullable"] or "default" in field or field.get("generated") is not None
        written.append(
            {
                "column": field,
                "prop": prop,
                "cs": cs,
                "valueType": value_type,
                "optional": optional,
                "propType": f"{cs}?" if optional else cs,
                "nested": nested,
            }
        )
    return {"name": name, "path": path, "fields": written, "classes": classes, "listed": listed}


def nested_classes(columns: list[dict], entity: str) -> dict[str, dict]:
    """The classes of the nested documents of a collection, by column."""
    taken = {entity, *(pascal_name(column["name"]) for column in columns)}
    result = {}
    for column in columns:
        nested = _nested_class(column, entity, taken)
        if nested:
            result[column["name"]] = nested
    return result


def document_type(column: dict, classes: dict[str, dict]) -> tuple[str, bool]:
    """The C# type of a column of a collection."""
    nested = classes.get(column["name"])
    return _value_type(column["type"], nested["path"] if nested else None)


# Checks


def _error(path: str, message: str) -> str:
    return f"errors.Add(new FieldError({path}, {cs_string(message)}));"


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _limits(checks: list[dict], value: str, path: str) -> list[str]:
    result = []
    for index, check in enumerate(checks):
        parsed = check.get("parsed")
        if not parsed:
            continue
        held = f"held{index}"
        if parsed["kind"] == "compare":
            limit = number_text(parsed["value"])
            refused = f"!(Convert.ToDecimal({held}) {parsed['op']} {limit}m)"
            message = f"must be {parsed['op']} {limit}"
        elif parsed["kind"] == "length":
            limit = number_text(parsed["value"])
            refused = f"!({held}.ToString()!.Length {parsed['op']} {limit})"
            message = f"must have {parsed['op']} {limit} characters"
        else:
            values = [_text(item) for item in parsed["values"]]
            invariant = f"Convert.ToString({held}, System.Globalization.CultureInfo.InvariantCulture)"
            refused = f"!new[] {{ {', '.join(cs_string(item) for item in values)} }}.Contains({invariant})"
            message = f"must be one of: {', '.join(values)}"
        result.append(f"if ({value} is {{ }} {held} && {refused}) {_error(path, message)}")
    return result


def _check_name(nested: dict) -> str:
    """The method that checks a nested document."""
    return "Check" + "".join(nested["path"].split(".")[1:]).replace("Document", "")


def _type_checks(
    column_type: dict, value: str, path: str, nested: dict | None, enums: list[dict], depth: int = 0
) -> list[str]:
    """The lines that check a value of a type; nested documents are checked by the method of their class."""
    kind = column_type["kind"]
    if kind == "array":
        index = f"i{depth}"
        inside = _type_checks(
            column_type["items"], f"{value}[{index}]", f'{path} + "." + {index}', nested, enums, depth + 1
        )
        if not inside:
            return []
        return [
            f"if ({value} is not null)",
            "{",
            f"    for (var {index} = 0; {index} < {value}.Count; {index}++)",
            "    {",
            *(f"        {line}" for line in inside),
            "    }",
            "}",
        ]
    if kind == "json" and column_type.get("fields") is not None and nested:
        call = f"{_check_name(nested)}({value}, {path}, errors);"
        if depth > 0:
            return [f"if ({value} is null) {_error(path, 'is required')}", f"else {call}"]
        return [f"if ({value} is not null) {call}"]
    if kind == "enum":
        found = next((item for item in enums if item["name"] == column_type["name"]), None)
        values = found["values"] if found else []
        listed = ", ".join(cs_string(item) for item in values)
        message = f"must be one of: {', '.join(values)}"
        return [f"if ({value} is not null && !new[] {{ {listed} }}.Contains({value})) {_error(path, message)}"]
    if kind == "text" and column_type.get("length") is not None and not is_object_id(column_type):
        length = column_type["length"]
        message = f"is longer than {length} characters"
        return [f"if ({value} is not null && {value}.Length > {length}) {_error(path, message)}"]
    return []


def _check_methods(context: dict, item: dict) -> list[list[str]]:
    body = []
    for field in item["fields"]:
        if field["column"]["name"] == "_id":
            continue
        value = f"value.{field['prop']}"
        path = f"path + {cs_string('.' + field['column']['name'])}"
        # A value type that is not nullable is always there
        if not field["optional"] and not field["valueType"]:
            body.append(f"if ({value} is null) {_error(path, 'is required')}")
        body += _type_checks(field["column"]["type"], value, path, field["nested"], context["schema"]["enums"])
        # Each limit names what it holds
        held = local_name(field["prop"]).replace("@", "")
        for line in _limits(field["column"].get("checks") or [], value, path):
            body.append(re.sub(r"\bheld(\d+)\b", rf"{held}\1", line))
    result = [
        [
            f"/// <summary>What a {item['path']} does not follow of its rules, each with the path of its field.</summary>",
            f"private static void {_check_name(item)}({item['path']} value, string path, List<FieldError> errors)",
            "{",
            *(f"    {line}" for line in body),
            "}",
        ]
    ]
    for inner in item["classes"]:
        result += _check_methods(context, inner)
    return result


def document_check_methods(context: dict, info: dict) -> list[list[str]]:
    """The methods of a service that check the nested documents of its collection."""
    return [method for item in info["nested"].values() for method in _check_methods(context, item)]


def document_rules(context: dict, info: dict, column: dict) -> list[str]:
    """The lines that check a column that holds documents or a list, as `value` of a dictionary: cast to its type
    first."""
    column_type = column["column"]["type"]
    if not context["orm"].get("documents") or (column_type["kind"] != "array" and nested_fields(column_type) is None):
        return []
    name = column["column"]["name"]
    found = _type_checks(column_type, "document", cs_string(name), info["nested"].get(name), context["schema"]["enums"])
    return [f"var document = ({column['cs']})value;", *found] if found else []


def check_call(nested: dict, value: str, path: str) -> str:
    """The call that checks one document of a list before it is added."""
    return f"{_check_name(nested)}({value}, {cs_string(path)}, errors);"


# Items of lists


def list_of(info: dict, query: dict) -> dict:
    column = csharp_context.column_of(info, query["columns"][0])
    column_type = column["column"]["type"]["items"]
    nested = info["nested"].get(column["column"]["name"])
    name = local_name(re.sub(r"^(add|remove)", "", query["name"]))
    item = f"{name}Item" if any(other["local"] == name for other in info["key"]) else name
    cs = _value_type(column_type, nested["path"] if nested else None)[0]
    by = item_key(column_type)
    if by == "id":
        params = [{"name": f"{item}Id", "type": "string"}]
    elif by == "value":
        params = [{"name": item, "type": cs}]
    else:
        params = [{"name": "position", "type": "int"}]
    return {
        "column": column,
        "item": item,
        "cs": cs,
        "type": column_type,
        "nested": nested,
        "by": by,
        "params": params,
    }


def identified_lists(info: dict) -> list[dict]:
    """The lists of a collection whose documents have an identifier, which is made before they are stored."""
    return [
        column
        for column in info["columns"]
        if column["column"]["type"]["kind"] == "array" and item_key(column["column"]["type"]["items"]) == "id"
    ]
