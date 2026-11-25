"""Nested documents in a Swift project: a struct per nested document, inside the entity that holds it, the checks of their
rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
databases (orm["documents"]) have them. Mirrors web/src/core/generators/swift/documents.ts.

A nested struct is {"name", "path", "fields", "structs"}: `Line`, `Order.Line`, its fields and the structs inside it. A
nested field is {"column", "prop", "key", "sw", "nested"}. A list info is {"column", "item", "sw", "type", "nested", "by",
"params"}."""

import re

from ...js import number_text
from ...model.naming import singularize, split_words
from ...schema.documents import is_object_id, item_key, nested_fields
from . import context as swift_context
from .swift import member_name, sw_string, type_name

FREE = "BsonValue"
"""A value nothing says the shape of: what a document has, kept as it is."""

# Names an entity uses for something else, or Swift keeps for itself
_TAKEN = set(
    "String Int Double Float Bool Decimal Date Data UUID Array Optional Any Type Protocol Self Error Never Void"
    " Bson BsonValue BsonDocument Loaded".split(" ")
)


def value_type(column_type: dict, nested: str | None) -> tuple[str, bool]:
    """The Swift type of a value of a document, given the struct of the documents it holds, and whether its values can
    be ordered."""
    kind = column_type["kind"]
    if kind == "array":
        return f"[{value_type(column_type['items'], nested)[0]}]", False
    if kind == "json":
        return (nested if column_type.get("fields") is not None else FREE), False
    if kind == "unknown":
        return FREE, False
    # MongoDB has no dates without a time and no times of the day: their text
    if kind in ("date", "time"):
        return "String", True
    return swift_context.sw_type(column_type)


def _list_depth(column_type: dict) -> int:
    return 1 + _list_depth(column_type["items"]) if column_type["kind"] == "array" else 0


def _nested_struct(column: dict, parent: str, taken: set[str]) -> dict | None:
    fields = nested_fields(column["type"])
    if fields is None:
        return None
    words = split_words(column["name"])
    last = words[-1] if words else column["name"]
    if _list_depth(column["type"]) > 0:
        last = singularize(last)
    name = type_name(" ".join([*words[:-1], last]))
    while name in _TAKEN or name in taken:
        name += "Value"
    taken.add(name)
    path = f"{parent}.{name}"
    # A struct inside another does not take the name of one that encloses it
    inside = set(taken)
    structs: list[dict] = []
    used: set[str] = set()
    written = []
    for field in fields:
        nested = _nested_struct(field, path, inside)
        if nested:
            structs.append(nested)
        prop = "id" if field["name"] == "_id" else member_name(field["name"])
        while prop in used:
            prop = f"{prop.replace('`', '')}_"
        used.add(prop)
        sw = value_type(field["type"], nested["path"] if nested else None)[0]
        written.append({"column": field, "prop": prop, "key": prop.replace("`", ""), "sw": sw, "nested": nested})
    return {"name": name, "path": path, "fields": written, "structs": structs}


def nested_structs(columns: list[dict], entity: str) -> dict[str, dict]:
    """The structs of the nested documents of a collection, by column."""
    taken = {entity}
    result = {}
    for column in columns:
        nested = _nested_struct(column, entity, taken)
        if nested:
            result[column["name"]] = nested
    return result


# Checks


def _inside(text: str) -> str:
    """What is inside the quotes of a Swift string."""
    return sw_string(text)[1:-1]


def _push(path: str, message: str) -> str:
    return f'errors.append(FieldError("{path}", {sw_string(message)}))'


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _number(value) -> str:
    text = _text(value)
    return text if re.search(r"[.eE]", text) else f"{text}.0"


def _limits(field: dict, path: str) -> list[str]:
    decimal = field["sw"] == "Decimal"
    as_number = "NSDecimalNumber(decimal: held).doubleValue" if decimal else "Double(held)"
    as_text = "held" if field["sw"] == "String" else '"\\(held)"'
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
            condition = f"!({as_text}.count {parsed['op']} {limit})"
            message = f"must have {parsed['op']} {limit} characters"
        else:
            values = [_number(item) if numeric else sw_string(_text(item)) for item in parsed["values"]]
            condition = f"![{', '.join(values)}].contains({as_number if numeric else as_text})"
            message = f"must be one of: {', '.join(_text(item) for item in parsed['values'])}"
        result += [f"if {condition} {{", f"    {_push(path, message)}", "}"]
    return result


def _check_name(nested: dict) -> str:
    return f"check{nested['path'].replace('.', '')}"


def _type_checks(
    column_type: dict, value: str, path: str, nested: dict | None, enums: list[dict], depth: int = 0
) -> list[str]:
    """The lines that check a value of a type, known to be there; nested documents are checked by the function of their
    struct."""
    kind = column_type["kind"]
    if kind == "array":
        items = _type_checks(column_type["items"], f"item{depth}", f"{path}.\\(i{depth})", nested, enums, depth + 1)
        if not items:
            return []
        return [
            f"for (i{depth}, item{depth}) in {value}.enumerated() {{",
            *(f"    {line}" for line in items),
            "}",
        ]
    if kind == "json" and column_type.get("fields") is not None and nested:
        return [f'{_check_name(nested)}({value}, "{path}", &errors)']
    if kind == "enum":
        values = next((item["values"] for item in enums if item["name"] == column_type["name"]), [])
        choices = ", ".join(sw_string(item) for item in values)
        return [
            f"if ![{choices}].contains({value}) {{",
            f"    {_push(path, 'must be one of: ' + ', '.join(values))}",
            "}",
        ]
    if kind == "text" and column_type.get("length") is not None and not is_object_id(column_type):
        length = number_text(column_type["length"])
        return [
            f"if {value}.count > {length} {{",
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
        path = f"\\(path).{_inside(column['name'])}"
        required = not column["nullable"] and not column.get("default")
        rules = [
            *_type_checks(column["type"], "held", path, field["nested"], context["schema"]["enums"]),
            *_limits(field, path),
        ]
        missing = _push(path, "is required")
        if rules:
            body += [
                f"if let held = value.{field['prop']} {{",
                *(f"    {line}" for line in rules),
                *(["} else {", f"    {missing}"] if required else []),
                "}",
            ]
        elif required:
            body.append(f"if value.{field['prop']} == nil {{ {missing} }}")
    return [
        [
            f"/// What a {item['path']} does not follow of its rules, each with the path of its field.",
            f"fileprivate func {_check_name(item)}(_ value: {item['path']}, _ path: String, _ errors: inout [FieldError]) {{",
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
    return _type_checks(column_type, "value", _inside(name), info["nested"].get(name), context["schema"]["enums"])


def check_call(nested: dict, value: str, path: str) -> str:
    """The call that checks one document of a list before it is added."""
    return f"{_check_name(nested)}({value}, {sw_string(path)}, &errors)"


# Items of lists


def list_of(info: dict, query: dict) -> dict:
    column = swift_context.column_of(info, query["columns"][0])
    column_type = column["column"]["type"]["items"]
    nested = info["nested"].get(column["column"]["name"])
    name = member_name(re.sub(r"^(add|remove)", "", query["name"]))
    plain = name.replace("`", "")
    item = f"{plain}Item" if any(other["prop"] == name for other in info["key"]) else name
    sw = value_type(column_type, nested["path"] if nested else None)[0]
    by = item_key(column_type)
    if by == "id":
        params = [{"name": f"{item.replace('`', '')}Id", "type": "String"}]
    elif by == "value":
        params = [{"name": item, "type": sw}]
    else:
        params = [{"name": "position", "type": "Int"}]
    return {
        "column": column,
        "item": item,
        "sw": sw,
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
