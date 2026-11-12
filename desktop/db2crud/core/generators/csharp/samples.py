"""Sample values for the generated tests, as C# expressions: each one fits its column (type, length, precision, the
CHECK constraints the rules understand) and changes with n, an int of the generated factory, so rows made with
different numbers do not clash on unique columns. Mirrors web/src/core/generators/csharp/samples.ts."""

import math
import re

from ...js import number_text
from .csharp import cs_string


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [
        check["parsed"]
        for check in checks
        if check.get("parsed") is not None and check["parsed"]["column"] == column["column"]["name"]
    ]


def _whole(cs: str, text: str) -> str:
    literal = re.fullmatch(r"-?\d+", text) is not None
    if cs == "long":
        return f"{text}L" if literal else f"(long)({text})"
    if cs == "short":
        return f"(short)({text})"
    return text if literal else f"({text})"


def _number(column: dict, checks: list[dict]) -> str:
    low = 0
    for parsed in _checks_of(column, checks):
        if parsed["kind"] == "compare" and parsed["op"] in (">", ">="):
            low = max(low, math.ceil(parsed["value"]))
    return "n" if low == 0 else f"{low} + n"


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def sample_value(column: dict, checks: list[dict], enums: list[dict]) -> str:
    """A C# expression for a value of the column."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    cs = column["cs"]
    choices = next((parsed for parsed in _checks_of(column, checks) if parsed["kind"] == "in"), None)
    if choices:
        first = _text(choices["values"][0])
        if kind == "integer":
            return _whole(cs, first)
        if kind == "decimal":
            return f"{first}m"
        if kind == "float":
            if cs == "float":
                return f"{first}f"
            return first if "." in first else f"{first}.0"
        return cs_string(first)
    if kind == "integer":
        return _whole(cs, _number(column, checks))
    if kind == "decimal":
        scale = column_type.get("scale")
        scale = 2 if scale is None else scale
        precision = column_type.get("precision")
        integer_digits = precision - scale if precision is not None else 6
        if integer_digits <= 0:
            return f"0.{'5'.rjust(scale, '0')}m"
        whole_part = f"n % {10 ** min(integer_digits, 4)}"
        return f"({whole_part}) + 0.{'5'.ljust(scale, '0')}m" if scale > 0 else f"(decimal)({whole_part})"
    if kind == "float":
        return f"{_number(column, checks)} + 0.5f" if cs == "float" else f"{_number(column, checks)} + 0.5"
    if kind == "text":
        length = column_type.get("length")
        length = 40 if length is None else length
        if column_type.get("fixed"):
            return f"(n % {10 ** min(length, 9)}).ToString().PadLeft({length}, '0')"
        # The column name and the number, as long as it fits; n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["column"]["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'$"{prefix}-{{n}}"' if prefix else f"(n % {10 ** min(length, 9)}).ToString()"
    if kind == "enum":
        item = next((item for item in enums if item["name"] == column_type["name"]), None)
        return cs_string(item["values"][0] if item and item["values"] else "value")
    if kind == "boolean":
        return "true"
    if kind == "date":
        return "new DateOnly(2026, 1, n % 28 + 1)"
    if kind == "time":
        if cs == "DateTimeOffset":
            return "new DateTimeOffset(1970, 1, 1, 12, n % 60, 0, TimeSpan.Zero)"
        return "new TimeOnly(12, n % 60)"
    if kind == "datetime":
        if cs == "DateTimeOffset":
            return "new DateTimeOffset(2026, 1, n % 28 + 1, 12, 0, 0, TimeSpan.Zero)"
        return "new DateTime(2026, 1, n % 28 + 1, 12, 0, 0)"
    if kind == "uuid":
        return 'Guid.Parse($"00000000-0000-4000-8000-{n:D12}")'
    if kind == "binary":
        return "new byte[] { (byte)n }"
    if kind == "json":
        return '$"{{\\"n\\": {n}}}"'
    if kind == "array":
        return '"[]"'
    return '$"value-{n}"'


def missing_value(column: dict) -> str:
    """A key no row has, as a C# expression, for the tests of missing rows."""
    return {
        "long": "999999L",
        "int": "999999",
        "short": "(short)9999",
        "decimal": "999999m",
        "double": "999999.0",
        "float": "999999f",
        "Guid": 'Guid.Parse("00000000-0000-4000-8000-000000999999")',
        "DateOnly": "new DateOnly(1999, 1, 1)",
    }.get(column["cs"], '"missing"')
