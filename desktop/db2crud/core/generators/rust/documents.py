"""Nested documents in a Rust project: a struct per nested document, in the module of the entity that holds it, the checks
of their rules in the services, and the items of lists that operations add and remove one by one. Only strategies of
document databases (orm["documents"]) have them. Mirrors web/src/core/generators/rust/documents.ts.

A nested struct is {"name", "path", "fields", "structs"}: `OrderLine`, `crate::entities::order::OrderLine`, its fields and
the structs of the documents inside it. A nested field is {"column", "field", "rs", "crate", "copy", "nested"}. A list info
is {"column", "item", "rs", "copy", "type", "nested", "by", "params"}."""

import re

from ...js import number_text
from ...model.naming import singularize, split_words
from ...schema.documents import is_object_id, item_key, nested_fields
from . import context as rust_context
from .rust import rs_string, snake_name, type_name

FREE = "mongodb::bson::Bson"
"""A value nothing says the shape of, as the driver has it."""


def value_type(column_type: dict, nested: str | None) -> tuple[str, str | None, bool]:
    """The Rust type of a value of a document, given the struct of the documents it holds: the type, its crate and
    whether it is copied."""
    kind = column_type["kind"]
    if kind == "array":
        rs, crate, _ = value_type(column_type["items"], nested)
        return f"Vec<{rs}>", crate, False
    if kind == "json":
        return (nested if column_type.get("fields") is not None else FREE), None, False
    if kind == "unknown":
        return FREE, None, False
    # MongoDB keeps moments in UTC
    if kind == "datetime":
        return "chrono::DateTime<chrono::Utc>", "chrono", True
    # MongoDB has no dates without a time and no times of the day: their text
    if kind in ("date", "time"):
        return "String", None, False
    return rust_context.rs_type(column_type)


def _list_depth(column_type: dict) -> int:
    return 1 + _list_depth(column_type["items"]) if column_type["kind"] == "array" else 0


def _nested_struct(column: dict, parent: str, module: str, taken: set[str]) -> dict | None:
    fields = nested_fields(column["type"])
    if fields is None:
        return None
    words = split_words(column["name"])
    last = words[-1] if words else column["name"]
    if _list_depth(column["type"]) > 0:
        last = singularize(last)
    name = parent + re.sub(r"^_", "", type_name(" ".join([*words[:-1], last])))
    while name in taken:
        name += "Value"
    taken.add(name)
    structs: list[dict] = []
    used: set[str] = set()
    written = []
    for item in fields:
        nested = _nested_struct(item, name, module, taken)
        if nested:
            structs.append(nested)
        field = "id" if item["name"] == "_id" else snake_name(item["name"])
        while field in used:
            field += "_"
        used.add(field)
        rs, crate, copy = value_type(item["type"], nested["path"] if nested else None)
        written.append({"column": item, "field": field, "rs": rs, "crate": crate, "copy": copy, "nested": nested})
    return {"name": name, "path": f"{module}::{name}", "fields": written, "structs": structs}


def nested_structs(columns: list[dict], entity: str, module: str) -> dict[str, dict]:
    """The structs of the nested documents of a collection, by column."""
    taken = {entity}
    result = {}
    for column in columns:
        nested = _nested_struct(column, entity, module, taken)
        if nested:
            result[column["name"]] = nested
    return result


def nested_crates(structs) -> list[str]:
    """Every crate the nested documents need."""
    result = []
    for item in structs:
        result += [field["crate"] for field in item["fields"] if field["crate"]]
        result += nested_crates(item["structs"])
    return result


# Checks. Where a value is, is the text of a format string: `lines`, `{path}.quantity`


def _path_text(text: str) -> str:
    return f"&format!({rs_string(text)})" if "{" in text else rs_string(text)


def _escaped(name: str) -> str:
    return name.replace("{", "{{").replace("}", "}}")


def _push(path: str, message: str) -> str:
    return f"errors.push(FieldError::new({_path_text(path)}, {rs_string(message)}));"


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _number(value) -> str:
    text = _text(value)
    return text if re.search(r"[.eE]", text) else f"{text}.0"


def _limits(field: dict, path: str) -> list[str]:
    decimal = field["rs"] == "rust_decimal::Decimal"
    as_number = "f64::try_from(*held).unwrap_or(f64::NAN)" if decimal else "(*held as f64)"
    as_text = "held.as_str()" if field["rs"] == "String" else "held.to_string().as_str()"
    numeric = field["column"]["type"]["kind"] in ("integer", "decimal", "float")
    result = []
    for check in field["column"].get("checks") or []:
        parsed = check.get("parsed")
        if not parsed:
            continue
        if parsed["kind"] == "compare":
            condition = f"!({as_number} {parsed['op']} {_number(parsed['value'])})"
            message = f"must be {parsed['op']} {_text(parsed['value'])}"
        elif parsed["kind"] == "length":
            limit = _text(parsed["value"])
            condition = f"!({as_text}.chars().count() {parsed['op']} {limit})"
            message = f"must have {parsed['op']} {limit} characters"
        else:
            values = [_number(item) if numeric else rs_string(_text(item)) for item in parsed["values"]]
            condition = f"![{', '.join(values)}].contains(&{as_number if numeric else as_text})"
            message = f"must be one of: {', '.join(_text(item) for item in parsed['values'])}"
        result += [f"if {condition} {{", f"    {_push(path, message)}", "}"]
    return result


def _check_name(nested: dict) -> str:
    return f"check_{re.sub(r'^r#', '', snake_name(nested['name']))}"


def _type_checks(
    column_type: dict, value: str, path: str, nested: dict | None, enums: list[dict], errors: str, depth: int = 0
) -> list[str]:
    """The lines that check a value of a type (a reference, known to be there); nested documents are checked by the
    function of their struct."""
    kind = column_type["kind"]
    if kind == "array":
        inside = _type_checks(
            column_type["items"], f"item{depth}", f"{path}.{{i{depth}}}", nested, enums, errors, depth + 1
        )
        if not inside:
            return []
        return [
            f"for (i{depth}, item{depth}) in {value}.iter().enumerate() {{",
            *(f"    {line}" for line in inside),
            "}",
        ]
    if kind == "json" and column_type.get("fields") is not None and nested:
        return [f"{_check_name(nested)}({value}, {_path_text(path)}, {errors});"]
    if kind == "enum":
        values = next((item["values"] for item in enums if item["name"] == column_type["name"]), [])
        choices = ", ".join(rs_string(item) for item in values)
        return [
            f"if ![{choices}].contains(&{value}.as_str()) {{",
            f"    {_push(path, 'must be one of: ' + ', '.join(values))}",
            "}",
        ]
    if kind == "text" and column_type.get("length") is not None and not is_object_id(column_type):
        length = number_text(column_type["length"])
        return [
            f"if {value}.chars().count() > {length} {{",
            f"    {_push(path, f'is longer than {length} characters')}",
            "}",
        ]
    return []


def _check_functions(context: dict, item: dict) -> list[list[str]]:
    body: list[str] = []
    for field in item["fields"]:
        column = field["column"]
        if column["name"] == "_id":
            continue
        path = f"{{path}}.{_escaped(column['name'])}"
        required = not column["nullable"] and not column.get("default")
        rules = [
            *_type_checks(column["type"], "held", path, field["nested"], context["schema"]["enums"], "errors"),
            *_limits(field, path),
        ]
        missing = _push(path, "is required")
        if rules:
            body += [
                f"if let Some(held) = &value.{field['field']} {{",
                *(f"    {line}" for line in rules),
                *(["} else {", f"    {missing}"] if required else []),
                "}",
            ]
        elif required:
            body += [f"if value.{field['field']}.is_none() {{", f"    {missing}", "}"]
    mark = "" if body else "_"
    params = f"{mark}value: &{item['path']}, {mark}path: &str, {mark}errors: &mut Vec<FieldError>"
    return [
        [
            f"/// What a {item['name']} does not follow of its rules, each with the path of its field.",
            f"fn {_check_name(item)}({params}) {{",
            *(f"    {line}" for line in body),
            "}",
        ],
        *(block for inner in item["structs"] for block in _check_functions(context, inner)),
    ]


def document_check_functions(context: dict, info: dict, columns: list[str]) -> list[list[str]]:
    """The functions of a service that check the nested documents of some columns."""
    return [
        block for name in columns if name in info["nested"] for block in _check_functions(context, info["nested"][name])
    ]


def document_rules(context: dict, info: dict, column: dict) -> list[str]:
    """The lines that check a column that holds documents or a list, as `value`."""
    column_type = column["column"]["type"]
    if not context["orm"].get("documents") or (column_type["kind"] != "array" and nested_fields(column_type) is None):
        return []
    name = column["column"]["name"]
    return _type_checks(
        column_type, "value", _escaped(name), info["nested"].get(name), context["schema"]["enums"], "&mut errors"
    )


def check_call(nested: dict, value: str, path: str) -> str:
    """The call that checks one document of a list before it is added."""
    return f"{_check_name(nested)}(&{value}, {rs_string(path)}, &mut errors);"


# Items of lists


def list_of(info: dict, query: dict) -> dict:
    column = rust_context.column_of(info, query["columns"][0])
    column_type = column["column"]["type"]["items"]
    nested = info["nested"].get(column["column"]["name"])
    name = snake_name(re.sub(r"^(add|remove)", "", query["name"]))
    plain = re.sub(r"^r#", "", name)
    item = f"{plain}_item" if any(other["field"] == name for other in info["key"]) else name
    rs, _, copy = value_type(column_type, nested["path"] if nested else None)
    by = item_key(column_type)
    if by == "id":
        params = [{"name": f"{re.sub(r'^r#', '', item)}_id", "type": "String", "copy": False}]
    elif by == "value":
        params = [{"name": item, "type": rs, "copy": copy}]
    else:
        params = [{"name": "position", "type": "usize", "copy": True}]
    return {
        "column": column,
        "item": item,
        "rs": rs,
        "copy": copy,
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
