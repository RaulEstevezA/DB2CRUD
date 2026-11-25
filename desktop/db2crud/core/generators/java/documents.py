"""Nested documents in a Java project: a class per nested document, inside the entity that holds it, the checks of their
rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
databases (orm["documents"]) have them. Mirrors web/src/core/generators/java/documents.ts.

A nested class is {"name", "path", "fields", "classes"}: `Line`, `Order.Line`, its fields and the classes inside it. A
nested field is {"column", "prop", "java", "getter", "setter", "nested"}, whose nested is the class of the document it
holds, or of each of its list. A list info is {"column", "item", "java", "type", "nested", "by", "params"}."""

import re

from ...js import number_text
from ...model.naming import singularize, split_words
from ...schema.documents import is_object_id, item_key, nested_fields
from . import context as java_context
from .java import JavaImports, capitalized, java_string, member_name, type_name

# Names an entity uses for something else
_TAKEN = {
    "Document",
    "Field",
    "FieldType",
    "Id",
    "Indexed",
    "CompoundIndex",
    "CompoundIndexes",
    "Instant",
    "List",
    "Object",
    "String",
    "BigDecimal",
    "UUID",
    "Boolean",
    "Integer",
    "Long",
    "Double",
    "Map",
}


def _class_name_of(field: str, many: bool, taken: set[str]) -> str:
    words = split_words(field)
    last = words[-1] if words else field
    name = type_name(" ".join([*words[:-1], singularize(last) if many else last]))
    while name in _TAKEN or name in taken:
        name += "Value"
    taken.add(name)
    return name


def _value_type(column_type: dict, nested: str | None) -> str:
    """The Java type of a value of a document, given the class of the documents it holds."""
    kind = column_type["kind"]
    if kind == "array":
        return f"List<{_value_type(column_type['items'], nested)}>"
    if kind == "json":
        return nested if column_type.get("fields") is not None else "Object"
    if kind == "datetime":
        return "Instant"
    # MongoDB has no dates without a time and no times of the day: their text
    if kind in ("date", "time"):
        return "String"
    if kind == "unknown":
        return "Object"
    return java_context.java_type(column_type)[0]


def _imports_of(column_type: dict, entity: str) -> list[str]:
    kind = column_type["kind"]
    if kind == "array":
        return ["java.util.List", *_imports_of(column_type["items"], entity)]
    if kind == "json":
        return [entity] if column_type.get("fields") is not None else []
    if kind == "datetime":
        return ["java.time.Instant"]
    if kind in ("date", "time", "unknown"):
        return []
    java_import = java_context.java_type(column_type)[1]
    return [java_import] if java_import else []


def _nested_class(column: dict, parent: str, taken: set[str], in_list: bool = False) -> dict | None:
    fields = nested_fields(column["type"])
    if fields is None:
        return None
    # In a list, at any depth: lists are written whole, so it carries the fields its class does not know
    listed = in_list or column["type"]["kind"] == "array"
    name = _class_name_of(column["name"], column["type"]["kind"] == "array", taken)
    path = f"{parent}.{name}"
    # A class inside another cannot have the name of one that encloses it
    inside = set(taken)
    classes = []
    used: set[str] = set()
    written = []
    for field in fields:
        nested = _nested_class(field, path, inside, listed)
        if nested:
            classes.append(nested)
        prop = "id" if field["name"] == "_id" else member_name(field["name"])
        while prop in used:
            prop += "_"
        used.add(prop)
        written.append(
            {
                "column": field,
                "prop": prop,
                "java": _value_type(field["type"], nested["path"] if nested else None),
                "getter": f"get{capitalized(prop)}",
                "setter": f"set{capitalized(prop)}",
                "nested": nested,
            }
        )
    return {"name": name, "path": path, "fields": written, "classes": classes, "listed": listed}


def nested_classes(columns: list[dict], entity: str) -> dict[str, dict]:
    """The classes of the nested documents of a collection, by column."""
    taken = {entity}
    result = {}
    for column in columns:
        nested = _nested_class(column, entity, taken)
        if nested:
            result[column["name"]] = nested
    return result


def document_type(column: dict, classes: dict[str, dict], entity: str) -> tuple[str, str | None]:
    """The Java type of a column of a collection and what to import for it: several names, when it needs them."""
    imports = list(dict.fromkeys(_imports_of(column["type"], entity)))
    nested = classes.get(column["name"])
    return _value_type(column["type"], nested["path"] if nested else None), ",".join(imports) if imports else None


def nested_imports(classes) -> list[str]:
    """Every import the nested classes of an entity need."""
    result = []
    for item in classes:
        for field in item["fields"]:
            result += _imports_of(field["column"]["type"], "")
        result += nested_imports(item["classes"])
    return [name for name in result if name]


# Checks


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _error(path: str, message: str) -> str:
    return f"errors.add(new FieldError({path}, {java_string(message)}));"


def _limits(checks: list[dict], value: str, path: str, imports: JavaImports) -> list[str]:
    result = []
    for check in checks:
        parsed = check.get("parsed")
        if not parsed:
            continue
        if parsed["kind"] in ("compare", "length"):
            op, bound = parsed["op"], _text(parsed["value"])
        if parsed["kind"] == "compare":
            imports.add("java.math.BigDecimal")
            result.append(
                f"if ({value} != null && !(new BigDecimal(String.valueOf({value})).compareTo(new BigDecimal({java_string(bound)})) {op} 0)) {_error(path, f'must be {op} {bound}')}"
            )
        elif parsed["kind"] == "length":
            result.append(
                f"if ({value} != null && !(String.valueOf({value}).length() {op} {bound})) {_error(path, f'must have {op} {bound} characters')}"
            )
        else:
            values = [_text(item) for item in parsed["values"]]
            message = f"must be one of: {', '.join(values)}"
            choices = ", ".join(java_string(item) for item in values)
            result.append(
                f"if ({value} != null && !List.of({choices}).contains(String.valueOf({value}))) {_error(path, message)}"
            )
    return result


def _check_name(nested: dict) -> str:
    return f"check{''.join(nested['path'].split('.')[1:])}"


def _type_checks(
    column_type: dict, value: str, path: str, nested: dict | None, enums: list[dict], depth: int = 0
) -> list[str]:
    """The lines that check a value of a type; nested documents are checked by the method of their class."""
    kind = column_type["kind"]
    if kind == "array":
        index = f"i{depth}"
        inside = _type_checks(
            column_type["items"], f"{value}.get({index})", f'{path} + "." + {index}', nested, enums, depth + 1
        )
        if not inside:
            return []
        return [
            f"if ({value} != null) {{",
            f"    for (int {index} = 0; {index} < {value}.size(); {index}++) {{",
            *(f"        {line}" for line in inside),
            "    }",
            "}",
        ]
    if kind == "json" and column_type.get("fields") is not None and nested:
        call = f"{_check_name(nested)}({value}, {path}, errors);"
        if depth > 0:
            return [f"if ({value} == null) {_error(path, 'is required')}", f"else {call}"]
        return [f"if ({value} != null) {call}"]
    if kind == "enum":
        item = next((item for item in enums if item["name"] == column_type["name"]), None)
        values = item["values"] if item else []
        message = f"must be one of: {', '.join(values)}"
        choices = ", ".join(java_string(value_) for value_ in values)
        return [f"if ({value} != null && !List.of({choices}).contains({value})) {_error(path, message)}"]
    if kind == "text" and column_type.get("length") is not None and not is_object_id(column_type):
        length = column_type["length"]
        return [
            f"if ({value} != null && {value}.length() > {length}) {_error(path, f'is longer than {length} characters')}"
        ]
    return []


def _check_methods(context: dict, item: dict, imports: JavaImports) -> list[list[str]]:
    body = []
    for field in item["fields"]:
        column = field["column"]
        if column["name"] == "_id":
            continue
        value = f"value.{field['getter']}()"
        path = f"path + {java_string('.' + column['name'])}"
        if not column["nullable"] and not column.get("default"):
            body.append(f"if ({value} == null) {_error(path, 'is required')}")
        body += _type_checks(column["type"], value, path, field["nested"], context["schema"]["enums"])
        body += _limits(column.get("checks") or [], value, path, imports)
    if any("List.of(" in line for line in body):
        imports.add("java.util.List")
    result = [
        [
            f"/** What a {item['name']} does not follow of its rules, each with the path of its field. */",
            f"private static void {_check_name(item)}({item['path']} value, String path, List<FieldError> errors) {{",
            *(f"    {line}" for line in body),
            "}",
        ]
    ]
    for inner in item["classes"]:
        result += _check_methods(context, inner, imports)
    return result


def document_check_methods(context: dict, info: dict, imports: JavaImports) -> list[list[str]]:
    """The methods of a service that check the nested documents of its collection."""
    classes = list(info["nested"].values())
    if not classes:
        return []
    imports.add("java.util.List", f"{java_context.errors_package(context)}.FieldError")
    return [method for item in classes for method in _check_methods(context, item, imports)]


def document_rules(context: dict, info: dict, column: dict) -> list[str]:
    """The lines that check a column that holds documents or a list, as `value` of a map: cast to its type first."""
    column_type = column["column"]["type"]
    if not context["orm"].get("documents") or (column_type["kind"] != "array" and nested_fields(column_type) is None):
        return []
    name = column["column"]["name"]
    rules = _type_checks(
        column_type, "document", java_string(name), info["nested"].get(name), context["schema"]["enums"]
    )
    if not rules:
        return []
    return [
        *(['@SuppressWarnings("unchecked")'] if "<" in column["java"] else []),
        f"{column['java']} document = ({column['java']}) value;",
        *rules,
    ]


# Items of lists


def list_of(info: dict, query: dict) -> dict:
    column = java_context.column_of(info, query["columns"][0])
    items = column["column"]["type"]["items"]
    nested = info["nested"].get(column["column"]["name"])
    name = member_name(re.sub(r"^(add|remove)", "", query["name"]))
    item = f"{name}Item" if any(other["prop"] == name for other in info["key"]) else name
    java = _value_type(items, nested["path"] if nested else None)
    by = item_key(items)
    if by == "id":
        params = [{"name": f"{item}Id", "type": "String"}]
    elif by == "value":
        params = [{"name": item, "type": java}]
    else:
        params = [{"name": "position", "type": "int"}]
    return {
        "column": column,
        "item": item,
        "java": java,
        "type": items,
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
