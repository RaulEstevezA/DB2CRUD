"""What the Python generators share (FastAPI and Django REST Framework): identifiers that follow PEP 8, Python
literals, and the Python type of each API type. Each framework adds its own syntax on top. Mirrors
web/src/core/generators/languages/python/python.ts.
"""

import json
import re

from ....js import number_text
from ....model.naming import to_pascal_case, to_snake_case
from ...common.text import compare_key

_KEYWORDS = {
    "False",
    "None",
    "True",
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield",
    "match",
    "case",
    "type",
    # Names the generated modules already use
    "id_",
    "self",
    "cls",
    "date",
    "datetime",
    "time",
    "decimal",
    "json",
    "uuid",
}

_DIGIT_START = re.compile(r"^[0-9]")


def py_name(name: str) -> str:
    """A snake_case identifier: createdAt → created_at; a keyword gets a trailing underscore."""
    snake = to_snake_case(name) or "value"
    safe = f"_{snake}" if _DIGIT_START.match(snake) else snake
    return f"{safe}_" if safe in _KEYWORDS else safe


def py_class(name: str) -> str:
    """A PascalCase class name: order_line → OrderLine."""
    pascal = to_pascal_case(name) or "Model"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def py_module(name: str) -> str:
    """A Python module name: OrderLine → order_line."""
    return re.sub(r"_$", "", py_name(name), count=1)


def py_string(value: str) -> str:
    """A Python string literal with double quotes."""
    return json.dumps(value, ensure_ascii=False)


def py_literal(value) -> str:
    """A JSON value as a Python literal."""
    if value is None:
        return "None"
    if value is True:
        return "True"
    if value is False:
        return "False"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return py_string(value)
    if isinstance(value, list):
        return f"[{', '.join(py_literal(item) for item in value)}]"
    return "{" + ", ".join(f"{py_string(key)}: {py_literal(item)}" for key, item in value.items()) + "}"


_STANDARD = {
    "__future__",
    "collections.abc",
    "copy",
    "logging",
    "secrets",
    "dataclasses",
    "datetime",
    "decimal",
    "enum",
    "os",
    "typing",
    "uuid",
    "contextlib",
    "functools",
    "collections",
    "itertools",
}


def _is_project(module: str) -> bool:
    return (
        module == "app"
        or module.startswith("app.")
        or module.startswith(".")
        or module == "tests"
        or module.startswith("tests.")
    )


class PyImports:
    """Imports a module needs, collected while writing it and printed sorted at the top."""

    def __init__(self) -> None:
        self._modules: dict[str, dict[str, None]] = {}

    def add(self, module: str, *names: str) -> "PyImports":
        """from <module> import <name>"""
        found = self._modules.setdefault(module, {})
        for name in names:
            found[name] = None
        return self

    def render(self) -> str:
        """Import lines: standard library first, then third-party packages, then the project, as isort does."""
        groups = [(module, sorted(names)) for module, names in self._modules.items()]

        def line(group: tuple[str, list[str]]) -> str:
            module, names = group
            return f"import {module}" if not names else f"from {module} import {', '.join(names)}"

        def ordered(items: list[tuple[str, list[str]]]) -> list[str]:
            return [line(item) for item in sorted(items, key=lambda item: compare_key(item[0]))]

        blocks = [
            ordered([group for group in groups if group[0] in _STANDARD]),
            ordered([group for group in groups if group[0] not in _STANDARD and not _is_project(group[0])]),
            ordered([group for group in groups if _is_project(group[0])]),
        ]
        return "\n\n".join("\n".join(block) for block in blocks if block)


_SCALARS = {
    "string": ("str", None),
    "integer": ("int", None),
    "float": ("float", None),
    "decimal": ("Decimal", ("decimal", "Decimal")),
    "boolean": ("bool", None),
    "date": ("date", ("datetime", "date")),
    "datetime": ("datetime", ("datetime", "datetime")),
    "time": ("time", ("datetime", "time")),
    "duration": ("timedelta", ("datetime", "timedelta")),
    "uuid": ("UUID", ("uuid", "UUID")),
    "binary": ("bytes", None),
    "any": ("Any", ("typing", "Any")),
}


def py_type(type_ref: dict, imports: PyImports, names) -> str:
    """The Python annotation of an API type. names has object(name) and enum(name): the class names of the
    embedded objects and enums."""
    kind = type_ref["kind"]
    if kind == "scalar":
        annotation, needed = _SCALARS.get(type_ref["scalar"], ("Any", None))
        if needed:
            imports.add(*needed)
        return annotation
    if kind == "array":
        return f"list[{py_type(type_ref['items'], imports, names)}]"
    if kind == "map":
        return f"dict[str, {py_type(type_ref['value'], imports, names)}]"
    if kind == "object":
        return names.object(type_ref["name"])
    return names.enum(type_ref["name"])


def py_docstring(text: str) -> str:
    """A module docstring: the first statement of a Python file."""
    return f'"""{text}"""'
