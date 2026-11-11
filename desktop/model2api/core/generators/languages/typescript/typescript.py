"""What the TypeScript generators share (Express and NestJS): identifiers, string and value literals, property
names that need quotes, and the imports of a module. Mirrors
web/src/core/generators/languages/typescript/typescript.ts.
"""

import re

from ....js import number_text, trim_end
from ....model.naming import to_camel_case, to_pascal_case
from ...common.text import compare_key

_RESERVED = {
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "let",
    "static",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "await",
    "any",
    "boolean",
    "number",
    "string",
    "symbol",
    "type",
    "object",
}

_DIGIT_START = re.compile(r"^[0-9]")
_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def ts_name(name: str) -> str:
    """A camelCase identifier; a reserved word gets a trailing underscore."""
    camel = to_camel_case(name) or "value"
    safe = f"_{camel}" if _DIGIT_START.match(camel) else camel
    return f"{safe}_" if safe in _RESERVED else safe


def ts_type(name: str) -> str:
    """A PascalCase type or class name."""
    pascal = to_pascal_case(name) or "Model"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def ts_file(name: str) -> str:
    """A file name in kebab case: OrderLine → order-line."""
    return _CAMEL.sub(r"\1-\2", re.sub(r"_$", "", ts_name(name), count=1)).lower()


def ts_string(value: str) -> str:
    """A string literal with single quotes."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"


def ts_property(name: str) -> str:
    """A property name, quoted when it is not a plain identifier: name, 'postal-code'."""
    return name if _IDENTIFIER.match(name) else ts_string(name)


def ts_access(target: str, name: str) -> str:
    """A property access: body.name, body['postal-code']."""
    return f"{target}.{name}" if _IDENTIFIER.match(name) else f"{target}[{ts_string(name)}]"


_UNDEFINED = object()


def ts_literal(value=_UNDEFINED) -> str:
    """A JSON value as a TypeScript literal."""
    if value is _UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, str):
        return ts_string(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, list):
        return f"[{', '.join(ts_literal(item) for item in value)}]"
    entries = [f"{ts_property(key)}: {ts_literal(item)}" for key, item in value.items()]
    return "{}" if not entries else f"{{ {', '.join(entries)} }}"


class TsImports:
    """Imports a module needs, collected while writing it: packages first, then the project's own modules."""

    def __init__(self) -> None:
        self._values: dict[str, dict[str, None]] = {}
        self._types: dict[str, dict[str, None]] = {}

    def add(self, module: str, *names: str) -> "TsImports":
        found = self._values.setdefault(module, {})
        for name in names:
            found[name] = None
        return self

    def add_type(self, module: str, *names: str) -> "TsImports":
        """import type { … }: names used only as types."""
        found = self._types.setdefault(module, {})
        for name in names:
            found[name] = None
        return self

    def render(self) -> str:
        modules = list(dict.fromkeys([*self._values, *self._types]))
        modules.sort(key=lambda module: (module.startswith("."), compare_key(module)))
        rendered = []
        for module in modules:
            every = list(self._values.get(module, {}))
            values = [name for name in every if not name.startswith("* as ") and not name.startswith("default ")]
            special = [name for name in every if name.startswith("* as ") or name.startswith("default ")]
            types = [name for name in self._types.get(module, {}) if name not in values]
            lines = []
            for name in special:
                imported = name[8:] if name.startswith("default ") else name
                lines.append(f"import {imported} from '{module}'")
            named = [*sorted(values), *(f"type {name}" for name in sorted(types))]
            if named:
                lines.append(f"import {{ {', '.join(named)} }} from '{module}'")
            if not lines:
                lines.append(f"import '{module}'")
            rendered.append("\n".join(lines))
        return "\n".join(rendered)


def ts_doc(text: str) -> str:
    """A documentation comment: the first lines of a module."""
    body = [trim_end(f" * {line}") for line in text.split("\n")]
    return "\n".join(["/**", *body, " */"])


# The body of list() in the in-memory repositories of Express and NestJS: filters, order (items without a value
# last) and a window of items
MEMORY_LIST_BODY = [
    "    const value = (item: unknown, field: string) => (item as Record<string, unknown>)[field]",
    "    let items = [...this.items.values()].filter((item) => Object.entries(query.filters).every(([field, expected]) => value(item, field) === expected))",
    "    if (query.sort) {",
    "      const { field, descending } = query.sort",
    "      // Items without a value go last, whatever the order",
    "      const present = items.filter((item) => value(item, field) != null)",
    "      present.sort((a, b) => {",
    "        const left = value(a, field) as string | number",
    "        const right = value(b, field) as string | number",
    "        const order = left < right ? -1 : left > right ? 1 : 0",
    "        return descending ? -order : order",
    "      })",
    "      items = [...present, ...items.filter((item) => value(item, field) == null)]",
    "    }",
    "    const end = query.limit === undefined ? undefined : query.offset + query.limit",
    "    return { items: items.slice(query.offset, end).map((item) => structuredClone(item)), total: items.length }",
]
