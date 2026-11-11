"""What Kotlin generators need: identifiers, literals, the Kotlin type of each API type and the imports of a source
file. Ktor uses it; another Kotlin framework would too. Mirrors web/src/core/generators/languages/kotlin/kotlin.ts.
"""

import re

from ....js import js_string, number_text
from ....model.naming import to_camel_case, to_pascal_case, to_screaming_snake_case

# Hard keywords of Kotlin: a name can only be one of them between backticks
_KEYWORDS = set(
    (
        "as break class continue do else false for fun if in interface is null object package return super this throw "
        "true try typealias typeof val var when while"
    ).split(" ")
)

# Type names a generated class cannot take: the types of Kotlin, the JVM and Ktor every file may use, and the
# classes the project writes itself. A model with one of these names gets Item after it (Route → RouteItem).
_TAKEN_TYPES = set(
    (
        "Any Array Boolean Byte Char Double Enum Error Exception Float Int List Long Map Nothing Number Pair Regex Result "
        "Set Short String Unit Application Route Routing Database Table Column Query Instant LocalDate UUID BigDecimal Json "
        "JsonObject JsonElement Body Checks ApiException ErrorResponse ErrorBody ErrorDetail ListQuery ListResult "
        "PageResponse Clock Settings Tables"
    ).split(" ")
)

_DIGIT_START = re.compile(r"^[0-9]")


def kt_pascal(name: str) -> str:
    """A PascalCase name for a class."""
    pascal = to_pascal_case(name) or "Model"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def kt_class(name: str) -> str:
    """A class name that does not clash with the types every file of the project sees."""
    pascal = kt_pascal(name)
    return f"{pascal}Item" if pascal in _TAKEN_TYPES else pascal


def kt_name(name: str) -> str:
    """A camelCase name for properties, parameters and functions; a hard keyword goes between backticks."""
    camel = to_camel_case(name) or "value"
    safe = f"_{camel}" if _DIGIT_START.match(camel) else camel
    return f"`{safe}`" if safe in _KEYWORDS else safe


def kt_constant(value) -> str:
    """An enum entry: in progress → IN_PROGRESS."""
    name = to_screaming_snake_case(js_string(value)) or "VALUE"
    return f"VALUE_{name}" if _DIGIT_START.match(name) else name


def kt_package(name: str) -> str:
    """A package: each segment that is a hard keyword between backticks."""
    return ".".join(f"`{part}`" if part in _KEYWORDS else part for part in name.split("."))


def kt_string(value: str) -> str:
    """A Kotlin string literal: $ is escaped too, as Kotlin reads it as a template."""
    text = []
    for char in value:
        code = ord(char)
        if char == "\\":
            text.append("\\\\")
        elif char == '"':
            text.append('\\"')
        elif char == "$":
            text.append("\\$")
        elif char == "\n":
            text.append("\\n")
        elif char == "\r":
            text.append("\\r")
        elif char == "\t":
            text.append("\\t")
        elif code < 0x20:
            text.append(f"\\u{code:04x}")
        else:
            text.append(char)
    return '"' + "".join(text) + '"'


def kt_number(value, type_name: str) -> str:
    """A number as a Kotlin literal of a type: 5L, 1.5."""
    text = number_text(value)
    if type_name == "Long":
        return f"{text}L"
    if type_name == "Double":
        return f"{text}.0" if float(value).is_integer() else text
    return text


def kt_doc(text: str, indent: str = "") -> str:
    """A documentation comment, indented."""
    body = text.split("\n")
    if len(body) == 1:
        return f"{indent}/** {text} */"
    return "\n".join([f"{indent}/**", *(f"{indent} * {line}".rstrip() for line in body), f"{indent} */"])


def _group(name: str) -> int:
    if name.startswith("java."):
        return 1
    if name.startswith("javax."):
        return 2
    if name.startswith("kotlin."):
        return 3
    return 0


class KtImports:
    """Imports of a Kotlin file, sorted as ktlint does: others first, then java, javax and kotlin."""

    def __init__(self, own_package: str) -> None:
        self._package = own_package
        self._items: dict[str, None] = {}

    def add(self, *names: str) -> "KtImports":
        for name in names:
            if name[: name.rfind(".")] != self._package:
                self._items[name] = None
        return self

    def render(self) -> str:
        ordered = sorted(self._items, key=lambda name: (_group(name), name))
        return "\n".join(f"import {kt_package(name)}" for name in ordered)


def kt_header(package: str, imports: KtImports) -> list[str]:
    """The opening of a Kotlin file: its package and imports."""
    rendered = imports.render()
    return [f"package {kt_package(package)}", "", *([rendered, ""] if rendered else [])]


def kt_type(type_ref: dict, imports: KtImports, names) -> str:
    """The Kotlin type of an API type, without the nullability of the outermost type. names has shared(name) and
    common(name), the fully qualified names of the shared classes and of the project's helpers."""

    def helper(name: str) -> str:
        imports.add(names.common(name))
        return name

    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return "Long" if type_ref.get("bits") == 64 else "Int"
        if scalar == "float":
            return "Double"
        if scalar == "decimal":
            return helper("JsonDecimal")
        if scalar == "boolean":
            return "Boolean"
        if scalar == "date":
            return helper("JsonDate")
        if scalar == "datetime":
            return helper("JsonDateTime")
        if scalar == "uuid":
            return helper("JsonUuid")
        if scalar == "any":
            imports.add("kotlinx.serialization.json.JsonElement")
            return "JsonElement"
        return "String"
    if kind == "array":
        return f"List<{kt_type(type_ref['items'], imports, names)}>"
    if kind == "map":
        return f"Map<String, {kt_type(type_ref['value'], imports, names)}>"
    qualified = names.shared(type_ref["name"])
    imports.add(qualified)
    return qualified[qualified.rfind(".") + 1 :]
