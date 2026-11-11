"""Sample values for the generated tests, as TypeScript expressions: each one fits its column (type, length,
precision, the CHECK constraints the rules understand) and changes with n, so rows made with different numbers do
not clash on unique columns. Mirrors web/src/core/generators/typescript/samples.ts."""

import math
import re

from ..python.python import js_json


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [check["parsed"] for check in checks if check.get("parsed") and check["parsed"]["column"] == column["name"]]


def _literal(value) -> str:
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace("'", "\\'")
        return f"'{escaped}'"
    return js_json(value)


def _number(column: dict, checks: list[dict]) -> str:
    """A whole number that changes with n and stays above the lower bound a CHECK sets."""
    parsed = _checks_of(column, checks)
    choices = next((item for item in parsed if item["kind"] == "in"), None)
    if choices:
        return _literal(choices["values"][0])
    low = 0
    for item in parsed:
        if item["kind"] == "compare" and item["op"] in (">", ">="):
            low = max(low, math.ceil(item["value"]))
    return "n" if low == 0 else f"{low} + n"


def _two_digits(expression: str) -> str:
    return f"String({expression}).padStart(2, '0')"


def sample_value(column: dict, checks: list[dict], enums: list[dict]) -> str:
    """A TypeScript expression for a value of the column."""
    column_type = column["type"]
    kind = column_type["kind"]
    choices = next((item for item in _checks_of(column, checks) if item["kind"] == "in"), None)
    if choices and kind not in ("integer", "decimal", "float"):
        return _literal(choices["values"][0])
    if kind == "integer":
        return _number(column, checks)
    if kind == "decimal":
        # Exact decimals are text: small enough for the precision, never more digits than the column keeps
        scale = column_type.get("scale", 2)
        integer_digits = column_type["precision"] - scale if "precision" in column_type else 6
        if integer_digits <= 0:
            return f"'0.{'5'.rjust(scale, '0')}'"
        whole = f"n % {10 ** min(integer_digits, 4)}"
        return f"`${{{whole}}}.{'5'.ljust(scale, '0')}`" if scale > 0 else f"String({whole})"
    if kind == "float":
        return f"{_number(column, checks)} + 0.5"
    if kind == "text":
        length = column_type.get("length", 40)
        if column_type.get("fixed"):
            return f"String(n).padStart({length}, '0').slice(-{length})"
        # The column name and the number, as long as it fits; n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f"`{prefix}-${{n}}`" if prefix else f"String(n).slice(-{length})"
    if kind == "enum":
        item = next((candidate for candidate in enums if candidate["name"] == column_type["name"]), None)
        return _literal(item["values"][0] if item else "value")
    if kind == "boolean":
        return "true"
    if kind == "date":
        return f"`2026-01-${{{_two_digits('(n % 28) + 1')}}}`"
    if kind == "time":
        return f"`12:${{{_two_digits('n % 60')}}}:00`"
    if kind == "datetime":
        return "new Date(Date.UTC(2026, 0, (n % 28) + 1, 12, 0, 0))"
    if kind == "uuid":
        return "`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`"
    if kind == "binary":
        return "Buffer.from([n % 256])"
    if kind == "json":
        return "{ n }"
    if kind == "array":
        return "[]"
    return "`value-${n}`"


def missing_value(column_type: dict) -> str:
    """A key no row has, as a TypeScript expression, for the tests of missing rows."""
    kind = column_type["kind"]
    if kind in ("integer", "float"):
        return "999999"
    if kind == "decimal":
        return "'999999'"
    if kind == "uuid":
        return "'00000000-0000-4000-8000-000000999999'"
    return "'missing'"
