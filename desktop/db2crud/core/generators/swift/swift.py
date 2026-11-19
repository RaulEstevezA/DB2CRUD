"""What the Swift generator needs: identifiers (camelCase members, PascalCase types), Swift string literals, and the
imports of a file, sorted. Mirrors web/src/core/generators/swift/swift.ts."""

import re

from ...model.naming import to_camel_case, to_pascal_case

# Keywords Swift reserves in declarations and expressions: a name that is one of them goes between backticks
KEYWORDS = set(
    (
        "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator "
        "private precedencegroup protocol public rethrows static struct subscript typealias var break case catch "
        "continue default defer do else fallthrough for guard if in repeat return throw switch where while Any as "
        "await false is nil self Self super throws true try"
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


def sw_string(text: str) -> str:
    """A Swift string literal."""
    escaped = (
        text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )
    return f'"{escaped}"'


def imports(*modules: str) -> str:
    """The import lines of a file, sorted."""
    return "\n".join(f"import {module}" for module in sorted(set(modules)))
