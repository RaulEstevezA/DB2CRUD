"""Sample values for the generated tests, as Swift expressions: each one fits its column (type, length, precision, the
CHECK constraints the rules understand) and changes with n, an Int of the generated factory, so rows made with
different numbers do not clash on unique columns. Mirrors web/src/core/generators/swift/samples.ts."""

import re

from ...js import js_string
from ..samples import bounded_number
from .documents import FREE
from .swift import sw_string


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [
        check["parsed"]
        for check in checks
        if check.get("parsed") is not None and check["parsed"]["column"] == column["column"]["name"]
    ]


def _whole(column: dict, checks: list[dict]) -> str:
    """A whole number that changes with n and stays within the bounds a CHECK sets."""
    return bounded_number(_checks_of(column, checks), "n", column["column"]["type"]["kind"] == "float")


def sw_literal_of(column: dict, value) -> str:
    """A literal of a value, in the column's Swift type."""
    text = js_string(value)
    if column["sw"] == "Int":
        return text
    if column["sw"] in ("Double", "Float"):
        return text if re.search(r"[.eE]", text) else f"{text}.0"
    if column["sw"] == "Decimal":
        return f"Decimal(string: {sw_string(text)})!"
    return sw_string(text)


# A day of 2026 that changes with n, at noon
DAY = "Date(timeIntervalSince1970: TimeInterval(1_767_268_800 + (n % 28) * 86_400))"


def sample_value(column: dict, checks: list[dict], enums: list[dict]) -> str:
    """A Swift expression for a value of the column."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    choices = next((parsed for parsed in _checks_of(column, checks) if parsed["kind"] == "in"), None)
    if choices:
        return sw_literal_of(column, choices["values"][0])
    if kind == "integer":
        return _whole(column, checks)
    if kind == "decimal":
        scale = column_type.get("scale")
        scale = 2 if scale is None else scale
        precision = column_type.get("precision")
        integer_digits = precision - scale if precision is not None else 6
        if integer_digits <= 0:
            return f"Decimal(string: {sw_string('0.' + '5'.rjust(scale, '0'))})!"
        part = f"n % {10 ** min(integer_digits, 4)}"
        if scale > 0:
            return f'Decimal(string: "\\({part}).{"5".ljust(scale, "0")}")!'
        return f"Decimal({part})"
    if kind == "float":
        return f"{column['sw']}({_whole(column, checks)}) + 0.5"
    if kind == "text":
        if column_type.get("objectId"):
            return 'String(format: "%024x", n)'
        length = column_type.get("length")
        length = 40 if length is None else length
        if column_type.get("fixed"):
            return f'String(format: "%0{length}d", n % {10 ** min(length, 9)})'
        # The column name and the number, as long as it fits; n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["column"]["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'"{prefix}-\\(n)"' if prefix else f"String(n % {10 ** min(length, 9)})"
    if kind == "enum":
        values = next((item["values"] for item in enums if item["name"] == column_type["name"]), None)
        return sw_string(values[0] if values else "value")
    if kind == "boolean":
        return "true"
    if kind == "date" and column["sw"] == "String":
        return 'String(format: "2026-01-%02d", n % 28 + 1)'
    if kind in ("date", "datetime"):
        return DAY
    if kind == "time":
        if column["sw"] == "String":
            return 'String(format: "12:%02d:00", n % 60)'
        return "TimeOfDay(hour: 12, minute: n % 60)"
    if kind == "uuid":
        return 'UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!'
    if kind == "binary":
        # As long as the column, when its length may be fixed: the database fills shorter values
        length = column_type.get("length")
        return (
            f"Data(repeating: UInt8(n % 256), count: {length})"
            if length is not None and length <= 64
            else "Data([UInt8(n % 256)])"
        )
    if kind == "json":
        if column["sw"] == FREE:
            return 'BsonValue(["n": n] as BsonDocument)'
        return '"{\\"n\\": \\(n)}"'
    if kind == "array":
        return '"[]"'
    return '"value-\\(n)"'


MISSING = {
    "Int": "999999",
    "Decimal": "Decimal(999999)",
    "Double": "999999.0",
    "Float": "999999.0",
    "UUID": 'UUID(uuidString: "00000000-0000-4000-8000-000000999999")!',
    "Date": "Date(timeIntervalSince1970: 0)",
    "TimeOfDay": "TimeOfDay(hour: 0, minute: 0, second: 1)",
    "Bool": "false",
    "Data": "Data([255, 255])",
}


def missing_value(column: dict) -> str:
    """A key no row has, as a Swift expression, for the tests of missing rows."""
    if column["column"]["type"].get("objectId"):
        return f'"{"f" * 24}"'
    return MISSING.get(column["sw"], '"missing"')
