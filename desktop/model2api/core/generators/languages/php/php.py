"""What PHP generators need (Laravel, and Symfony after it): class and variable names, string and value literals,
the `use` statements of a file and documentation comments. Mirrors web/src/core/generators/languages/php/php.ts.
"""

import re

from ....js import number_text, trim_end
from ....model.naming import to_camel_case, to_pascal_case, to_snake_case
from ...common.text import compare_key

# Words PHP does not allow as class names, compared without case
_RESERVED_CLASSES = {
    "abstract", "and", "array", "as", "bool", "break", "callable", "case", "catch", "class", "clone", "const",
    "continue", "declare", "default", "do", "echo", "else", "elseif", "empty", "enum", "eval", "exit", "extends",
    "false", "final", "finally", "float", "fn", "for", "foreach", "function", "global", "goto", "if", "implements",
    "include", "instanceof", "insteadof", "int", "interface", "isset", "iterable", "list", "match", "mixed",
    "namespace", "never", "new", "null", "object", "or", "parent", "print", "private", "protected", "public",
    "readonly", "require", "return", "self", "static", "string", "switch", "throw", "trait", "true", "try",
    "unset", "use", "var", "void", "while", "xor", "yield",
}  # fmt: skip

_DIGIT_START = re.compile(r"^[0-9]")


def php_class(name: str) -> str:
    """A PascalCase class name; a word PHP reserves gets Item after it (List → ListItem)."""
    pascal = to_pascal_case(name) or "Model"
    safe = f"_{pascal}" if _DIGIT_START.match(pascal) else pascal
    return f"{safe}Item" if safe.lower() in _RESERVED_CLASSES else safe


def php_name(name: str) -> str:
    """A camelCase name for variables, properties and methods (PHP allows reserved words there)."""
    camel = to_camel_case(name) or "value"
    return f"_{camel}" if _DIGIT_START.match(camel) else camel


def php_snake(name: str) -> str:
    """A snake_case name for database tables and columns: postalCode → postal_code."""
    return to_snake_case(name) or "value"


def php_string(value: str) -> str:
    """A string literal with single quotes, where only \\ and ' are escaped."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def php_literal(value) -> str:
    """A JSON value as a PHP literal: objects and lists are arrays."""
    if value is None:
        return "null"
    if isinstance(value, str):
        return php_string(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, list):
        return "[" + ", ".join(php_literal(item) for item in value) + "]"
    return "[" + ", ".join(f"{php_string(key)} => {php_literal(item)}" for key, item in value.items()) + "]"


class PhpImports:
    """The `use` statements of a file, sorted, without the classes of the file's own namespace."""

    def __init__(self, namespace: str) -> None:
        self._namespace = namespace
        self._names: dict[str, None] = {}

    def add(self, *classes: str) -> "PhpImports":
        for name in classes:
            if name[: name.rfind("\\")] != self._namespace:
                self._names[name] = None
        return self

    def render(self) -> str:
        return "\n".join(f"use {name};" for name in sorted(self._names, key=compare_key))


def php_doc(text: str, indent: str = "") -> str:
    """A documentation comment, indented."""
    body = text.split("\n")
    if len(body) == 1:
        return f"{indent}/** {text} */"
    return "\n".join([f"{indent}/**", *(trim_end(f"{indent} * {line}") for line in body), f"{indent} */"])


def php_header(namespace: str, imports: PhpImports) -> list[str]:
    """The opening of a PHP file in a namespace, with its `use` statements."""
    uses = imports.render()
    return ["<?php", "", f"namespace {namespace};", "", *([uses, ""] if uses else [])]


def php_regex(pattern: str) -> str:
    """A PCRE pattern for Laravel's regex rule: the source between delimiters, Unicode aware."""
    source = ""
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\":
            # An escape is copied whole, so an already escaped "/" stays as it is
            source += char + pattern[index + 1 : index + 2]
            index += 2
            continue
        source += "\\/" if char == "/" else char
        index += 1
    return f"/{source}/u"
