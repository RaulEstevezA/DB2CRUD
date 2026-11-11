"""What Rust generators need: identifiers, literals, the Rust type of each API type and the use declarations of a
source file. Axum uses it; another Rust framework would too. Mirrors web/src/core/generators/languages/rust/rust.ts.
"""

import re

from ....model.naming import to_pascal_case, to_snake_case

# Keywords of Rust: a name can only be one of them as a raw identifier (r#type)
_KEYWORDS = set(
    (
        "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut "
        "pub ref return self static struct super trait true type unsafe use where while abstract become box do final macro "
        "override priv typeof unsized virtual yield try gen"
    ).split(" ")
)

# Names a raw identifier cannot take either
_NOT_RAW = {"crate", "self", "super", "Self"}

# Type names a generated type cannot take: the prelude of Rust, the types the files of an Axum project import, and
# the types the project writes itself. A model with one of these names gets Item after it.
_TAKEN_TYPES = set(
    (
        "Option Result String Vec Box Some None Ok Err Self Json Path Query State Router Response StatusCode Value Map "
        "Bytes Uuid Decimal NaiveDate NaiveDateTime DateTime Utc Model Entity Column ActiveModel Relation Settings AppState "
        "ApiError ErrorDetail Checks Body ListQuery ListResult PageResponse Clock Authenticated Claims Ordering"
    ).split(" ")
)

_DIGIT_START = re.compile(r"^[0-9]")


def rs_pascal(name: str) -> str:
    """A PascalCase name for a type or an enum variant."""
    pascal = to_pascal_case(name) or "Model"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def rs_type(name: str) -> str:
    """A type name that does not clash with the types every file of the project sees."""
    pascal = rs_pascal(name)
    return f"{pascal}Item" if pascal in _TAKEN_TYPES else pascal


def rs_name(name: str) -> str:
    """A snake_case name for fields, variables and functions; a keyword becomes a raw identifier."""
    snake = to_snake_case(name) or "value"
    safe = f"_{snake}" if _DIGIT_START.match(snake) else snake
    if safe in _NOT_RAW:
        return f"{safe}_"
    return f"r#{safe}" if safe in _KEYWORDS else safe


def rs_module(name: str) -> str:
    """A snake_case name for a module or a file, never a keyword."""
    snake = to_snake_case(name) or "item"
    safe = f"_{snake}" if _DIGIT_START.match(snake) else snake
    return f"{safe}_" if safe in _KEYWORDS or safe in _NOT_RAW else safe


def rs_string(value: str) -> str:
    """A Rust string literal."""
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


def rs_doc(text: str, indent: str = "") -> str:
    """A documentation comment, indented: /// text."""
    return "\n".join(f"{indent}/// {line}".rstrip() for line in text.split("\n"))


def _group(path: str) -> int:
    if path.startswith("std::"):
        return 0
    return 2 if path.startswith("crate::") else 1


class RsUses:
    """The use declarations of a file: std first, then other crates, then this crate; each group sorted."""

    def __init__(self) -> None:
        self._items: dict[str, None] = {}

    def add(self, *paths: str) -> "RsUses":
        for path in paths:
            self._items[path] = None
        return self

    def render(self) -> str:
        # Sorted by UTF-16 code units, as JavaScript sorts
        ordered = sorted(self._items, key=lambda path: path.encode("utf-16-be"))
        groups = [[f"use {path};" for path in ordered if _group(path) == index] for index in range(3)]
        return "\n\n".join("\n".join(items) for items in groups if items)


def rs_header(doc: str, uses: RsUses) -> list[str]:
    """The opening of a Rust module: its documentation and its use declarations."""
    rendered = uses.render()
    return [*(f"//! {line}".rstrip() for line in doc.split("\n")), "", *([rendered, ""] if rendered else [])]


def rs_type_of(type_ref: dict, uses: RsUses, names) -> str:
    """The Rust type of an API type, without the Option of the outermost type. names.shared(name) is the use path
    of the type of an embedded object or an enum."""
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar in ("string", "time", "duration", "binary"):
            return "String"
        if scalar == "integer":
            return "i64" if type_ref.get("bits") == 64 else "i32"
        if scalar == "float":
            return "f64"
        if scalar == "decimal":
            uses.add("rust_decimal::Decimal")
            return "Decimal"
        if scalar == "boolean":
            return "bool"
        if scalar == "date":
            uses.add("chrono::NaiveDate")
            return "NaiveDate"
        if scalar == "datetime":
            uses.add("chrono::DateTime", "chrono::Utc")
            return "DateTime<Utc>"
        if scalar == "uuid":
            uses.add("uuid::Uuid")
            return "Uuid"
        if scalar == "any":
            uses.add("serde_json::Value")
            return "Value"
        return "String"
    if kind == "array":
        return f"Vec<{rs_type_of(type_ref['items'], uses, names)}>"
    if kind == "map":
        uses.add("std::collections::BTreeMap")
        return f"BTreeMap<String, {rs_type_of(type_ref['value'], uses, names)}>"
    path = names.shared(type_ref["name"])
    uses.add(path)
    return path[path.rfind("::") + 2 :]
