"""What the Rust generator needs: identifiers (snake_case members and modules, PascalCase types), Rust literals, and
the use lines of a file, sorted. Rust refuses an unused import, so a file adds only what its code names. Mirrors
web/src/core/generators/rust/rust.ts."""

import re

from ...model.naming import to_pascal_case, to_snake_case

# Keywords of Rust (2024 edition): a name that is one of them is written as a raw identifier
KEYWORDS = set(
    (
        "as async await break const continue dyn else enum extern false fn for gen if impl in let loop match mod move "
        "mut pub ref return static struct trait true try type unsafe use where while abstract become box do final "
        "macro override priv typeof unsized virtual yield"
    ).split(" ")
)

# Keywords that cannot be raw identifiers: they get a _ after them
NOT_RAW = {"crate", "self", "super", "Self"}


def _safe(name: str) -> str:
    base = f"_{name}" if re.match(r"^[0-9]", name) else name
    if base in NOT_RAW:
        return f"{base}_"
    return f"r#{base}" if base in KEYWORDS else base


def snake_name(name: str) -> str:
    """A field, variable, function or module name: OrderID → order_id; a keyword becomes r#type."""
    return _safe(to_snake_case(name) or "value")


def type_name(name: str) -> str:
    """order line → OrderLine."""
    base = to_pascal_case(name) or "Item"
    return f"_{base}" if re.match(r"^[0-9]", base) else base


def column_variant(field: str) -> str:
    """The variant of SeaORM's Column enum for a field: its name in UpperCamelCase, as the derive macro writes it."""
    parts = [part for part in re.sub(r"^r#", "", field).split("_") if part]
    return "".join(part[:1].upper() + part[1:] for part in parts)


def rs_string(text: str) -> str:
    """A Rust string literal."""
    escaped = (
        text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )
    return f'"{escaped}"'


def owned(text: str) -> str:
    """An owned String from a literal."""
    return f"{rs_string(text)}.to_string()"


class RsUses:
    """The use lines of one file, sorted; items of one path go together: use sea_orm::{EntityTrait, QueryFilter};"""

    def __init__(self):
        self._names: list[str] = []

    def add(self, *names: str) -> "RsUses":
        for name in names:
            if name not in self._names:
                self._names.append(name)
        return self

    def write(self) -> str:
        groups: dict[str, list[str]] = {}
        for name in self._names:
            split = name.rfind("::")
            groups.setdefault(name[:split], []).append(name[split + 2 :])
        result = []
        for path in sorted(groups):
            items = sorted(groups[path])
            result.append(f"use {path}::{items[0]};" if len(items) == 1 else f"use {path}::{{{', '.join(items)}}};")
        return "\n".join(result)
