"""Sample values for the generated tests, as Java expressions: each one fits its column (type, length, precision, the
CHECK constraints the rules understand) and changes with n, an int of the generated factory, so rows made with
different numbers do not clash on unique columns. Mirrors web/src/core/generators/java/samples.ts."""

import math
import re

from ...js import number_text
from .java import java_string


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [
        check["parsed"]
        for check in checks
        if check.get("parsed") is not None and check["parsed"]["column"] == column["column"]["name"]
    ]


def _whole(java: str, text: str) -> str:
    """A whole-number literal in the column's Java type."""
    if java == "Long":
        return f"{text}L" if re.fullmatch(r"-?\d+", text) else f"(long) ({text})"
    if java == "Short":
        return f"(short) ({text})"
    if java == "Integer":
        return text if re.fullmatch(r"-?\d+", text) else f"({text})"
    return text


def _number(column: dict, checks: list[dict]) -> str:
    """A whole number that changes with n and stays above the lower bound a CHECK sets."""
    low = 0
    for parsed in _checks_of(column, checks):
        if parsed["kind"] == "compare" and parsed["op"] in (">", ">="):
            low = max(low, math.ceil(parsed["value"]))
    return "n" if low == 0 else f"{low} + n"


def sample_imports(column: dict) -> list[str]:
    """The imports the samples of a column need."""
    result = []
    if column["javaImport"]:
        result.append(column["javaImport"])
    if column["java"] in ("OffsetDateTime", "OffsetTime"):
        result.append("java.time.ZoneOffset")
    return result


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def sample_value(column: dict, checks: list[dict], enums: list[dict]) -> str:
    """A Java expression for a value of the column."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    java = column["java"]
    choices = next((parsed for parsed in _checks_of(column, checks) if parsed["kind"] == "in"), None)
    if choices:
        first = _text(choices["values"][0])
        if kind == "integer":
            return _whole(java, first)
        if kind == "decimal":
            return f"new BigDecimal({java_string(first)})"
        if kind == "float":
            if java == "Float":
                return f"{first}f"
            return first if "." in first else f"{first}.0"
        return java_string(first)
    if kind == "integer":
        return _whole(java, _number(column, checks))
    if kind == "decimal":
        scale = column_type.get("scale")
        scale = 2 if scale is None else scale
        precision = column_type.get("precision")
        integer_digits = precision - scale if precision is not None else 6
        if integer_digits <= 0:
            return f'new BigDecimal("0.{"5".rjust(scale, "0")}")'
        whole_part = f"n % {10 ** min(integer_digits, 4)}"
        if scale > 0:
            return f'new BigDecimal(({whole_part}) + ".{"5".ljust(scale, "0")}")'
        return f"new BigDecimal(String.valueOf({whole_part}))"
    if kind == "float":
        return f"{_number(column, checks)} + 0.5f" if java == "Float" else f"{_number(column, checks)} + 0.5"
    if kind == "text":
        length = column_type.get("length")
        length = 40 if length is None else length
        if column_type.get("fixed"):
            return f'String.format("%0{length}d", n % {10 ** min(length, 9)})'
        # The column name and the number, as long as it fits; n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["column"]["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'"{prefix}-" + n' if prefix else f"String.valueOf(n % {10 ** min(length, 9)})"
    if kind == "enum":
        item = next((item for item in enums if item["name"] == column_type["name"]), None)
        return java_string(item["values"][0] if item and item["values"] else "value")
    if kind == "boolean":
        return "true"
    if kind == "date":
        return "LocalDate.of(2026, 1, n % 28 + 1)"
    if kind == "time":
        return "OffsetTime.of(12, n % 60, 0, 0, ZoneOffset.UTC)" if java == "OffsetTime" else "LocalTime.of(12, n % 60)"
    if kind == "datetime":
        if java == "OffsetDateTime":
            return "OffsetDateTime.of(2026, 1, n % 28 + 1, 12, 0, 0, 0, ZoneOffset.UTC)"
        return "LocalDateTime.of(2026, 1, n % 28 + 1, 12, 0)"
    if kind == "uuid":
        return 'UUID.fromString(String.format("00000000-0000-4000-8000-%012d", n))'
    if kind == "binary":
        return "new byte[] { (byte) n }"
    if kind == "json":
        return '"{\\"n\\": " + n + "}"'
    if kind == "array":
        return '"[]"'
    return '"value-" + n'


def missing_value(column: dict) -> str:
    """A key no row has, as a Java expression, for the tests of missing rows."""
    return {
        "Long": "999999L",
        "Integer": "999999",
        "Short": "(short) 9999",
        "BigDecimal": 'new BigDecimal("999999")',
        "Double": "999999.0",
        "Float": "999999f",
        "UUID": 'UUID.fromString("00000000-0000-4000-8000-000000999999")',
        "LocalDate": "LocalDate.of(1999, 1, 1)",
    }.get(column["java"], '"missing"')
