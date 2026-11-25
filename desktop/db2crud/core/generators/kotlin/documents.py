"""Nested documents in a Kotlin project: a data class per nested document, inside the entity that holds it, the checks of
their rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
databases (orm["documents"]) have them. Mirrors web/src/core/generators/kotlin/documents.ts.

A nested class is {"name", "path", "fields", "classes"}: `Line`, `Order.Line`, its fields and the classes inside it. A
nested field is {"column", "prop", "kt", "nested"}. A list info is {"column", "item", "kt", "type", "nested", "by",
"params"}."""

import re

from ...js import number_text
from ...model.naming import singularize, split_words
from ...schema.documents import is_object_id, item_key, nested_fields
from . import context as kotlin_context
from .kotlin import kt_string, member_name, type_name

# Names an entity uses for something else
_TAKEN = {
    "Any",
    "String",
    "List",
    "Int",
    "Long",
    "Double",
    "Boolean",
    "ByteArray",
    "Instant",
    "BigDecimal",
    "UUID",
    "ObjectId",
}


def _list_depth(column_type: dict) -> int:
    return 1 + _list_depth(column_type["items"]) if column_type["kind"] == "array" else 0


def value_type(column_type: dict, nested: str | None) -> str:
    """The Kotlin type of a value of a document, given the class of the documents it holds."""
    kind = column_type["kind"]
    if kind == "array":
        return f"List<{value_type(column_type['items'], nested)}>"
    if kind == "json":
        return nested if column_type.get("fields") is not None else "Any"
    if kind == "datetime":
        return "Instant"
    # MongoDB has no dates without a time and no times of the day: their text
    if kind in ("date", "time"):
        return "String"
    if kind == "unknown":
        return "Any"
    return kotlin_context.kt_type(column_type, "mongodb")[0]


def _imports_of(column_type: dict, entity: str) -> list[str]:
    kind = column_type["kind"]
    if kind == "array":
        return _imports_of(column_type["items"], entity)
    if kind == "json":
        return [entity] if column_type.get("fields") is not None and entity else []
    if kind == "datetime":
        return ["java.time.Instant"]
    if kind in ("date", "time", "unknown"):
        return []
    kt_import = kotlin_context.kt_type(column_type, "mongodb")[1]
    return [kt_import] if kt_import else []


def _nested_class(column: dict, parent: str, taken: set[str]) -> dict | None:
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
    # A class inside another cannot have the name of one that encloses it
    inside = set(taken)
    classes: list[dict] = []
    used: set[str] = set()
    written = []
    for field in fields:
        nested = _nested_class(field, path, inside)
        if nested:
            classes.append(nested)
        prop = "id" if field["name"] == "_id" else member_name(field["name"])
        while prop in used:
            prop += "_"
        used.add(prop)
        kt = value_type(field["type"], nested["path"] if nested else None)
        written.append({"column": field, "prop": prop, "kt": kt, "nested": nested})
    return {"name": name, "path": path, "fields": written, "classes": classes}


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
    """The Kotlin type of a column of a collection and what to import for it: several names, when it needs them."""
    imports = list(dict.fromkeys(_imports_of(column["type"], entity)))
    nested = classes.get(column["name"])
    return value_type(column["type"], nested["path"] if nested else None), ",".join(imports) or None


def nested_imports(classes) -> list[str]:
    """Every import the nested classes of an entity need."""
    result = []
    for item in classes:
        for field in item["fields"]:
            result += _imports_of(field["column"]["type"], "")
        result += nested_imports(item["classes"])
    return result


# Checks


def _error(path: str, message: str) -> str:
    return f"errors += FieldError({path}, {kt_string(message)})"


def _number(value) -> str:
    text = number_text(value)
    return text if re.search(r"[.eE]", text) else f"{text}.0"


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _limits(checks: list[dict], value: str, path: str) -> list[str]:
    result = []
    for check in checks:
        parsed = check.get("parsed")
        if not parsed:
            continue
        if parsed["kind"] == "compare":
            report = _error(path, f"must be {parsed['op']} {number_text(parsed['value'])}")
            result.append(f"if (!({value}.toDouble() {parsed['op']} {_number(parsed['value'])})) {report}")
        elif parsed["kind"] == "length":
            limit = number_text(parsed["value"])
            report = _error(path, f"must have {parsed['op']} {limit} characters")
            result.append(f"if (!({value}.toString().length {parsed['op']} {limit})) {report}")
        else:
            values = [_text(item) for item in parsed["values"]]
            report = _error(path, f"must be one of: {', '.join(values)}")
            result.append(
                f"if ({value}.toString() !in listOf({', '.join(kt_string(item) for item in values)})) {report}"
            )
    return result


def _check_name(nested: dict) -> str:
    return f"check{''.join(nested['path'].split('.')[1:])}"


def _type_checks(
    column_type: dict, value: str, path: str, nested: dict | None, enums: list[dict], depth: int = 0
) -> list[str]:
    """The lines that check a value of a type, known to be there; nested documents are checked by the function of their
    class."""
    kind = column_type["kind"]
    if kind == "array":
        inside = _type_checks(
            column_type["items"], f"item{depth}", f'{path} + "." + i{depth}', nested, enums, depth + 1
        )
        if not inside:
            return []
        return [f"{value}.forEachIndexed {{ i{depth}, item{depth} ->", *(f"    {line}" for line in inside), "}"]
    if kind == "json" and column_type.get("fields") is not None and nested:
        return [f"{_check_name(nested)}({value}, {path}, errors)"]
    if kind == "enum":
        values = next((item["values"] for item in enums if item["name"] == column_type["name"]), [])
        choices = ", ".join(kt_string(item) for item in values)
        return [f"if ({value} !in listOf({choices})) {_error(path, 'must be one of: ' + ', '.join(values))}"]
    if kind == "text" and column_type.get("length") is not None and not is_object_id(column_type):
        length = number_text(column_type["length"])
        return [f"if ({value}.length > {length}) {_error(path, f'is longer than {length} characters')}"]
    return []


def _check_functions(context: dict, item: dict) -> list[list[str]]:
    body: list[str] = []
    for field in item["fields"]:
        column = field["column"]
        if column["name"] == "_id":
            continue
        path = f"path + {kt_string('.' + column['name'])}"
        required = not column["nullable"] and not column.get("default")
        missing = f"if (value.{field['prop']} == null) {_error(path, 'is required')}"
        rules = [
            *_type_checks(column["type"], "held", path, field["nested"], context["schema"]["enums"]),
            *_limits(column.get("checks") or [], "held", path),
        ]
        if not rules:
            if required:
                body.append(missing)
            continue
        body.append(f"value.{field['prop']}.let {{ held ->")
        if required:
            body += [f"    if (held == null) {_error(path, 'is required')}", "    else {"]
        else:
            body.append("    if (held != null) {")
        body += [*(f"        {line}" for line in rules), "    }", "}"]
    return [
        [
            f"/** What a {item['path']} does not follow of its rules, each with the path of its field. */",
            *([] if body else ['@Suppress("UNUSED_PARAMETER")']),
            f"private fun {_check_name(item)}(value: {item['path']}, path: String, errors: MutableList<FieldError>) {{",
            *(f"    {line}" for line in body),
            "}",
        ],
        *(block for inner in item["classes"] for block in _check_functions(context, inner)),
    ]


def document_check_functions(context: dict, info: dict) -> list[list[str]]:
    """The functions of a service that check the nested documents of its collection."""
    return [block for item in info["nested"].values() for block in _check_functions(context, item)]


def document_rules(context: dict, info: dict, column: dict) -> list[str]:
    """The lines that check a column that holds documents or a list, as `value` of a map: cast to its type first."""
    column_type = column["column"]["type"]
    if not context["orm"].get("documents") or (column_type["kind"] != "array" and nested_fields(column_type) is None):
        return []
    name = column["column"]["name"]
    found = _type_checks(column_type, "document", kt_string(name), info["nested"].get(name), context["schema"]["enums"])
    return [f"val document = value as {column['kt']}", *found] if found else []


def check_call(nested: dict, value: str, path: str) -> str:
    """The call that checks one document of a list before it is added."""
    return f"{_check_name(nested)}({value}, {kt_string(path)}, errors)"


# Items of lists


def list_of(info: dict, query: dict) -> dict:
    column = kotlin_context.column_of(info, query["columns"][0])
    column_type = column["column"]["type"]["items"]
    nested = info["nested"].get(column["column"]["name"])
    name = member_name(re.sub(r"^(add|remove)", "", query["name"]))
    item = f"{name}Item" if any(other["prop"] == name for other in info["key"]) else name
    kt = value_type(column_type, nested["path"] if nested else None)
    by = item_key(column_type)
    if by == "id":
        params = [{"name": f"{item}Id", "type": "String"}]
    elif by == "value":
        params = [{"name": item, "type": kt}]
    else:
        params = [{"name": "position", "type": "Int"}]
    return {
        "column": column,
        "item": item,
        "kt": kt,
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
