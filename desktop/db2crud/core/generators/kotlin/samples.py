"""Sample values for the generated tests, as Kotlin expressions: each one fits its column (type, length, precision, the
CHECK constraints the rules understand) and changes with n, an Int of the generated factory, so rows made with
different numbers do not clash on unique columns. Mirrors web/src/core/generators/kotlin/samples.ts."""

import math
import re

from ...js import is_number, js_string
from .entities import kt_literal
from .kotlin import KtImports, kt_string


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [
        check["parsed"]
        for check in checks
        if check.get("parsed") is not None and check["parsed"]["column"] == column["column"]["name"]
    ]


def _whole(column: dict, checks: list[dict]) -> str:
    """A whole number that changes with n and stays above the lower bound a CHECK sets, in the column's type."""
    low = 0
    for parsed in _checks_of(column, checks):
        if parsed["kind"] == "compare" and parsed["op"] in (">", ">="):
            low = max(low, math.ceil(parsed["value"]))
    value = "n" if low == 0 else f"({low} + n)"
    if column["kt"] == "Long":
        return f"{value}.toLong()"
    if column["kt"] == "Short":
        return f"{value}.toShort()"
    return "n" if low == 0 else f"{low} + n"


def sample_value(column: dict, checks: list[dict], enums: list[dict], imports: KtImports) -> str:
    """A Kotlin expression for a value of the column, adding its imports."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    if column["ktImport"]:
        imports.add(column["ktImport"])
    choices = next((parsed for parsed in _checks_of(column, checks) if parsed["kind"] == "in"), None)
    if choices:
        first = choices["values"][0]
        if is_number(first) or kind in ("integer", "decimal", "float"):
            return kt_literal(column, first)
        return kt_string(js_string(first))
    if kind == "integer":
        return _whole(column, checks)
    if kind == "decimal":
        scale = column_type.get("scale")
        scale = 2 if scale is None else scale
        precision = column_type.get("precision")
        integer_digits = precision - scale if precision is not None else 6
        if integer_digits <= 0:
            return f"BigDecimal({kt_string('0.' + '5'.rjust(scale, '0'))})"
        part = f"n % {10 ** min(integer_digits, 4)}"
        return f'BigDecimal("${{{part}}}.{"5".ljust(scale, "0")}")' if scale > 0 else f"BigDecimal({part})"
    if kind == "float":
        whole = _whole({**column, "kt": "Int"}, checks)
        return f"{whole} + 0.5f" if column["kt"] == "Float" else f"{whole} + 0.5"
    if kind == "text":
        length = column_type.get("length")
        length = 40 if length is None else length
        if column_type.get("fixed"):
            return f"(n % {10 ** min(length, 9)}).toString().padStart({length}, '0')"
        # The column name and the number, as long as it fits; n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["column"]["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'"{prefix}-$n"' if prefix else f"(n % {10 ** min(length, 9)}).toString()"
    if kind == "enum":
        values = next((item["values"] for item in enums if item["name"] == column_type["name"]), None)
        return kt_string(values[0] if values else "value")
    if kind == "boolean":
        return "true"
    if kind == "date":
        return "LocalDate.of(2026, 1, n % 28 + 1)"
    if kind == "time":
        return "LocalTime.of(12, n % 60)"
    if kind == "datetime":
        if column["kt"] == "OffsetDateTime":
            imports.add("java.time.ZoneOffset")
            return "OffsetDateTime.of(2026, 1, n % 28 + 1, 12, 0, 0, 0, ZoneOffset.UTC)"
        if column["kt"] == "Instant":
            imports.add("java.time.LocalDateTime", "java.time.ZoneOffset")
            return "LocalDateTime.of(2026, 1, n % 28 + 1, 12, 0).toInstant(ZoneOffset.UTC)"
        return "LocalDateTime.of(2026, 1, n % 28 + 1, 12, 0)"
    if kind == "uuid":
        return 'UUID.fromString("00000000-0000-4000-8000-%012d".format(n))'
    if kind == "binary":
        return "byteArrayOf(n.toByte())"
    if kind == "json":
        return '"{\\"n\\": $n}"'
    if kind == "array":
        return '"[]"'
    return '"value-$n"'


MISSING = {
    "Long": "999999L",
    "Int": "999999",
    "Short": "9999.toShort()",
    "BigDecimal": 'BigDecimal("999999")',
    "Double": "999999.0",
    "Float": "999999f",
    "UUID": 'UUID.fromString("00000000-0000-4000-8000-000000999999")',
    "LocalDate": "LocalDate.of(1999, 1, 1)",
}


def missing_value(column: dict, imports: KtImports) -> str:
    """A key no row has, as a Kotlin expression, for the tests of missing rows."""
    if column["ktImport"]:
        imports.add(column["ktImport"])
    return MISSING.get(column["kt"], '"missing"')
