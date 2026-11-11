"""What PHP generators write the same about the data (Laravel and Symfony): the backed enums of the API, and the
statements that give the fields a body leaves out their default values. Mirrors
web/src/core/generators/languages/php/model.ts.
"""

from ....js import js_string, number_text
from ...common.text import file_text, lines
from .php import PhpImports, php_class, php_doc, php_header, php_literal, php_string


def enum_files(context, namespace: str) -> list[dict]:
    """The PHP enum of a spec enum, with a case per value."""
    files = []
    for item in context.spec["enums"]:
        used: set[str] = set()
        cases = []
        integer = item["valueType"] == "integer"
        for value in item["values"]:
            base = php_class(js_string(value))
            case = base
            n = 2
            while case in used:
                case = f"{base}{n}"
                n += 1
            used.add(case)
            literal = number_text(value) if integer else php_string(js_string(value))
            cases.append(f"    case {case} = {literal};")
        content = lines(
            *php_header(namespace, PhpImports(namespace)),
            php_doc(f"Values of {item['name']}, with the value each one has in JSON."),
            f"enum {php_class(item['name'])}: {'int' if integer else 'string'}",
            "{",
            cases,
            "}",
        )
        files.append({"path": context.class_path(namespace, php_class(item["name"])), "content": file_text(content)})
    return files


def _inner_object(context, type_ref: dict) -> dict | None:
    if type_ref["kind"] != "object":
        return None
    return next((item for item in context.spec["objects"] if item["name"] == type_ref["name"]), None)


def field_defaults(context, fields: list[dict], target: str, depth: int, top: bool) -> list[str]:
    """PHP statements that give the fields left out of an object their defaults, nested objects included."""
    statements: list[str] = []
    for field in fields:
        access = f"{target}[{php_string(field['wire'])}]"
        if top and "defaultValue" in field and not field["required"]:
            statements.extend(
                [
                    f"if (! array_key_exists({php_string(field['wire'])}, {target})) {{",
                    f"    {access} = {php_literal(field['defaultValue'])};",
                    "}",
                ]
            )
        if depth > 2 or field.get("reference"):
            continue
        spec_object = _inner_object(context, field["type"])
        if spec_object:
            nested = field_defaults(context, spec_object["fields"], access, depth + 1, True)
            if nested:
                statements.extend(
                    [f"if (isset({access}) && is_array({access})) {{", *(f"    {line}" for line in nested), "}"]
                )
        items = _inner_object(context, field["type"]["items"]) if field["type"]["kind"] == "array" else None
        if items:
            index = f"$index{depth}"
            nested = field_defaults(context, items["fields"], f"{access}[{index}]", depth + 1, True)
            if nested:
                statements.extend(
                    [
                        f"foreach (array_keys({access} ?? []) as {index}) {{",
                        f"    if (is_array({access}[{index}])) {{",
                        *(f"        {line}" for line in nested),
                        "    }",
                        "}",
                    ]
                )
    return statements
