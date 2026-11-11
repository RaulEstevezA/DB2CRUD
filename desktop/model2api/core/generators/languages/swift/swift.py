"""What Swift generators need: identifiers, literals and the Swift type of each API type. Vapor uses it; another
Swift framework would too. Mirrors web/src/core/generators/languages/swift/swift.ts.
"""

import re

from ....model.naming import to_camel_case, to_pascal_case

# Keywords of Swift: a name can only be one of them between backticks
_KEYWORDS = set(
    (
        "associatedtype class deinit enum extension fileprivate func import inout internal let open operator private "
        "precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default "
        "defer do else fallthrough for guard if in repeat return throw switch where while as await false is nil super "
        "throws true try any some"
    ).split(" ")
)

# Names that even backticks do not free for a property: they take _ after them
_NOT_ESCAPABLE = {"self", "Self", "init", "Type", "Protocol"}

# Type names a generated type cannot take: the types of Swift, Foundation, Vapor and Fluent every file may see, and
# the types the project writes itself. A model with one of these names gets Item after it.
_TAKEN_TYPES = set(
    (
        "Any String Int Int32 Int64 Double Float Bool Array Dictionary Set Optional Result Error Never Void Character Range "
        "Date UUID Data Decimal URL Codable Encodable Decodable Sendable Task Actor Request Response Application Route "
        "Routes RoutesBuilder Abort HTTPStatus HTTPMethod HTTPHeaders Environment Model Fields Migration AsyncMigration "
        "Database Schema Field Content Validation Validator Middleware Logger Storage Page Sort Filter JSON JSONValue "
        "ApiError ErrorDetail Checks JsonKind Body ListQuery ListResult PageResponse Clock Settings Security Claims "
        "Authenticated Params TestResponse Api TestLock"
    ).split(" ")
)

_DIGIT_START = re.compile(r"^[0-9]")


def sw_pascal(name: str) -> str:
    """A PascalCase name for a type or a case."""
    pascal = to_pascal_case(name) or "Model"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def sw_type(name: str) -> str:
    """A type name that does not clash with the types every file of the project sees."""
    pascal = sw_pascal(name)
    return f"{pascal}Item" if pascal in _TAKEN_TYPES else pascal


def sw_name(name: str) -> str:
    """A camelCase name for properties, variables and functions; a keyword goes between backticks."""
    camel = to_camel_case(name) or "value"
    safe = f"_{camel}" if _DIGIT_START.match(camel) else camel
    if safe in _NOT_ESCAPABLE:
        return f"{safe}_"
    return f"`{safe}`" if safe in _KEYWORDS else safe


def sw_string(value: str) -> str:
    """A Swift string literal."""
    text = []
    for char in value:
        code = ord(char)
        if char == "\\":
            text.append("\\\\")
        elif char == '"':
            text.append('\\"')
        elif char == "\n":
            text.append("\\n")
        elif char == "\r":
            text.append("\\r")
        elif char == "\t":
            text.append("\\t")
        elif code < 0x20:
            text.append(f"\\u{{{code:x}}}")
        else:
            text.append(char)
    return '"' + "".join(text) + '"'


def sw_doc(text: str, indent: str = "") -> str:
    """A documentation comment, indented: /// text."""
    return "\n".join(f"{indent}/// {line}".rstrip() for line in text.split("\n"))


def sw_header(doc: str, imports) -> list[str]:
    """The opening of a Swift file: what it holds and its imports, sorted."""
    ordered = sorted(set(imports), key=lambda item: item.encode("utf-16-be"))
    return [
        *(f"// {line}".rstrip() for line in doc.split("\n")),
        "",
        *([*(f"import {item}" for item in ordered), ""] if ordered else []),
    ]


class _TypeNames:
    """Enums and embedded objects are named as types of the module."""

    @staticmethod
    def shared(name: str) -> str:
        return sw_type(name)


TYPE_NAMES = _TypeNames()


def sw_type_of(type_ref: dict, names=TYPE_NAMES) -> str:
    """The Swift type of an API type, without the ? of the outermost type. Dates without time are ISO 8601 text;
    decimals are Decimal."""
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return "Int64" if type_ref.get("bits") == 64 else "Int32"
        if scalar == "float":
            return "Double"
        if scalar == "decimal":
            return "Decimal"
        if scalar == "boolean":
            return "Bool"
        if scalar == "datetime":
            return "Date"
        if scalar == "uuid":
            return "UUID"
        if scalar == "any":
            return "JSONValue"
        return "String"
    if kind == "array":
        return f"[{sw_type_of(type_ref['items'], names)}]"
    if kind == "map":
        return f"[String: {sw_type_of(type_ref['value'], names)}]"
    return names.shared(type_ref["name"])
