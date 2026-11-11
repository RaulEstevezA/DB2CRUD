"""What every Python generator needs: identifiers that follow PEP 8, Python literals and the imports of a module.
Mirrors web/src/core/generators/python/python.ts."""

import json

from ...js import number_text
from ...model.naming import split_words, to_pascal_case, to_snake_case

KEYWORDS = {
    *"False None True and as assert async await break class continue def del elif else except finally for from".split(),
    *"global if import in is lambda nonlocal not or pass raise return try while with yield match case type".split(),
}

STANDARD = {"collections", "collections.abc", "contextlib", "dataclasses", "datetime", "decimal", "enum", "os"}
STANDARD |= {"typing", "uuid"}


def js_json(value) -> str:
    """JSON.stringify of a string, number or boolean."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    return json.dumps(value, ensure_ascii=False)


def _safe(name: str) -> str:
    base = f"_{name}" if name[:1].isdigit() else name
    return f"{base}_" if base in KEYWORDS else base


def snake_name(name: str) -> str:
    """placedAt, placed_at → placed_at."""
    return _safe(to_snake_case(name) or "value")


def class_name(name: str) -> str:
    """order line → OrderLine."""
    return _safe(to_pascal_case(name) or "Item")


def method_name(neutral: str) -> str:
    """A camelCase neutral name (listByCustomerId) in Python: list_by_customer_id."""
    return _safe("_".join(split_words(neutral)).lower())


def py_literal(value) -> str:
    """A Python literal."""
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return number_text(value)
    return json.dumps(value, ensure_ascii=False)


class Imports:
    """The imports of one module, deduplicated and sorted into the three groups of isort."""

    def __init__(self) -> None:
        self._names: dict[str, set[str]] = {}
        self._modules: set[str] = set()
        self._postponed = False

    def annotations(self) -> "Imports":
        """from __future__ import annotations: a method named list cannot hide the built-in in later annotations."""
        self._postponed = True
        return self

    def from_(self, module: str, *names: str) -> "Imports":
        self._names.setdefault(module, set()).update(names)
        return self

    def module(self, module: str) -> "Imports":
        self._modules.add(module)
        return self

    def write(self, local: str) -> str:
        def group(module: str) -> int:
            if module in STANDARD:
                return 0
            return 2 if module == local or module.startswith(f"{local}.") else 1

        groups: list[list[str]] = [[], [], []]
        for module in sorted(self._modules | set(self._names)):
            target = groups[group(module)]
            if module in self._modules:
                target.append(f"import {module}")
            names = self._names.get(module)
            if names:
                target.append(f"from {module} import {', '.join(sorted(names))}")
        if self._postponed:
            groups.insert(0, ["from __future__ import annotations"])
        return "\n\n".join("\n".join(items) for items in groups if items)
