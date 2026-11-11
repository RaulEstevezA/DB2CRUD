"""Sample values for the generated tests, as Python expressions: each one fits its column (type, length, precision,
the CHECK constraints the rules understand) and changes with n, so rows made with different numbers do not clash on
unique columns. Mirrors web/src/core/generators/python/samples.ts."""

import math
import re

from .python import Imports, js_json


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [check["parsed"] for check in checks if check.get("parsed") and check["parsed"]["column"] == column["name"]]


def _number(column: dict, checks: list[dict]) -> str:
    """A whole number that changes with n and stays above the lower bound a CHECK sets."""
    parsed = _checks_of(column, checks)
    choices = next((item for item in parsed if item["kind"] == "in"), None)
    if choices:
        return js_json(choices["values"][0])
    low = 0
    for item in parsed:
        if item["kind"] == "compare" and item["op"] in (">", ">="):
            low = max(low, math.ceil(item["value"]))
    return "n" if low == 0 else f"{low} + n"


def sample_value(column: dict, checks: list[dict], enums: list[dict], imports: Imports) -> str:
    """A Python expression for a value of the column, adding its imports."""
    column_type = column["type"]
    kind = column_type["kind"]
    choices = next((item for item in _checks_of(column, checks) if item["kind"] == "in"), None)
    if choices and kind not in ("integer", "decimal", "float"):
        return js_json(choices["values"][0])
    if kind == "integer":
        return _number(column, checks)
    if kind == "decimal":
        imports.from_("decimal", "Decimal")
        scale = column_type.get("scale", 2)
        integer_digits = column_type["precision"] - scale if "precision" in column_type else 6
        if integer_digits <= 0:
            return f'Decimal("0.{"5".rjust(scale, "0")}")'
        modulo = 10 ** min(integer_digits, 4)
        if scale > 0:
            return f'Decimal(f"{{n % {modulo}}}.{"5".ljust(scale, "0")}")'
        return f"Decimal(n % {modulo})"
    if kind == "float":
        return f"{_number(column, checks)} + 0.5"
    if kind == "text":
        length = column_type.get("length", 40)
        if column_type.get("fixed"):
            return f'f"{{n:0{length}d}}"[-{length}:]'
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'f"{prefix}-{{n}}"' if prefix else f'f"{{n}}"[-{length}:]'
    if kind == "enum":
        item = next((candidate for candidate in enums if candidate["name"] == column_type["name"]), None)
        return js_json(item["values"][0] if item else "value")
    if kind == "boolean":
        return "True"
    if kind == "date":
        imports.from_("datetime", "date")
        return "date(2026, 1, n % 28 + 1)"
    if kind == "time":
        imports.from_("datetime", "time")
        return "time(12, n % 60)"
    if kind == "datetime":
        imports.from_("datetime", "datetime")
        return "datetime(2026, 1, n % 28 + 1, 12, 0, 0)"
    if kind == "uuid":
        imports.from_("uuid", "UUID")
        return "UUID(int=n)"
    if kind == "binary":
        return "bytes([n % 256])"
    if kind == "array":
        return "[]"
    if kind == "json":
        return '{"n": n}'
    return 'f"value-{n}"'


def missing_value(column_type: dict, imports: Imports) -> str:
    """A key no row has, as a Python expression, for the tests of missing rows."""
    if column_type["kind"] in ("integer", "decimal", "float"):
        return "999999"
    if column_type["kind"] == "uuid":
        imports.from_("uuid", "UUID")
        return "UUID(int=999999)"
    return '"missing"'
