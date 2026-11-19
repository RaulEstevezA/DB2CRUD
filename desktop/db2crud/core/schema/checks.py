"""The forms of a CHECK constraint the rules understand, read from its SQL text: a column in a list of values, a
column compared with a number, and the length of a column compared with a number. Anything else keeps only its
text. Shared by the readers of ORM code and of DDL, which find CHECKs as written. Mirrors
web/src/core/schema/checks.ts."""

import re

from ..js import number, trim

_IDENT = r"[\"`\[]?([A-Za-z_][A-Za-z0-9_]*)[\"`\]]?"
_NUMBER = r"(-?\d+(?:\.\d+)?)"
_OP = r"(>=|<=|>|<)"
_VALUE = re.compile(r"\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?))\s*(?:,|\Z)")

_IN = re.compile(rf"^{_IDENT}\s+IN\s*\((.*)\)\Z", re.I | re.S)
_LENGTH = re.compile(rf"^(?:LENGTH|CHAR_LENGTH|LEN)\s*\(\s*{_IDENT}\s*\)\s*{_OP}\s*{_NUMBER}\Z", re.I)
_COMPARE = re.compile(rf"^{_IDENT}\s*{_OP}\s*{_NUMBER}\Z")
_COMPARE_FLIPPED = re.compile(rf"^{_NUMBER}\s*{_OP}\s*{_IDENT}\Z")

# The comparison read the other way: `0 <= price` is `price >= 0`
_FLIPPED = {">": "<", ">=": "<=", "<": ">", "<=": ">="}


def _list_values(text: str) -> list | None:
    """The values of an IN list: quoted texts (with '' for a quote) or numbers."""
    values: list = []
    index = 0
    while index < len(text):
        match = _VALUE.match(text, index)
        if not match:
            return None
        values.append(match.group(1).replace("''", "'") if match.group(1) is not None else number(match.group(2)))
        index = match.end()
    return values or None


def parse_check(sql: str) -> dict | None:
    """What a CHECK says, when it is a form the rules understand. Outer parentheses do not matter."""
    text = trim(sql)
    while text.startswith("(") and text.endswith(")"):
        text = trim(text[1:-1])
    match = _IN.match(text)
    if match:
        values = _list_values(match.group(2))
        return {"kind": "in", "column": match.group(1), "values": values} if values else None
    match = _LENGTH.match(text)
    if match:
        return {"kind": "length", "column": match.group(1), "op": match.group(2), "value": number(match.group(3))}
    match = _COMPARE.match(text)
    if match:
        return {"kind": "compare", "column": match.group(1), "op": match.group(2), "value": number(match.group(3))}
    match = _COMPARE_FLIPPED.match(text)
    if match:
        return {
            "kind": "compare",
            "column": match.group(3),
            "op": _FLIPPED[match.group(2)],
            "value": number(match.group(1)),
        }
    return None


def check_of(sql: str, name: str | None = None) -> dict:
    """A CHECK as written, with what it says when the rules understand it."""
    parsed = parse_check(sql)
    return {**({"name": name} if name else {}), "sql": sql, **({"parsed": parsed} if parsed else {})}
