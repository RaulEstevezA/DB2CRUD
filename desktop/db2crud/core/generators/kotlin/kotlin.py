"""What the Kotlin generator needs: identifiers (PascalCase classes, camelCase members), Kotlin literals, and the
imports of a file, sorted, without the ones of its own package. Mirrors web/src/core/generators/kotlin/kotlin.ts."""

import re

from ...model.naming import to_camel_case, to_pascal_case

# Hard keywords of Kotlin: a name that is one of them goes between backticks
KEYWORDS = set(
    (
        "as break class continue do else false for fun if in interface is null object package return super this throw "
        "true try typealias typeof val var when while"
    ).split(" ")
)


def member_name(name: str) -> str:
    """order_id → orderId; a keyword goes between backticks."""
    base = to_camel_case(name) or "value"
    safe = f"_{base}" if re.match(r"^[0-9]", base) else base
    return f"`{safe}`" if safe in KEYWORDS else safe


def type_name(name: str) -> str:
    """order line → OrderLine."""
    base = to_pascal_case(name) or "Item"
    return f"_{base}" if re.match(r"^[0-9]", base) else base


def kt_string(text: str) -> str:
    """A Kotlin string literal; $ is escaped so nothing is interpolated."""
    escaped = (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("$", "\\$")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


class KtImports:
    """The imports of one file, sorted, without the classes of its own package."""

    def __init__(self, pkg: str):
        self._pkg = pkg
        self._names: list[str] = []

    def add(self, *names: str) -> "KtImports":
        for name in names:
            if name not in self._names:
                self._names.append(name)
        return self

    def write(self) -> str:
        names = sorted(name for name in self._names if name[: name.rfind(".")] != self._pkg)
        return "\n".join(f"import {name}" for name in names)
