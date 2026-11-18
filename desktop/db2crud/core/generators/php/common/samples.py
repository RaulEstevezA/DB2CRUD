"""Sample values for the generated tests, as PHP expressions: each one fits its column (type, length, precision, the
CHECK constraints the rules understand) and changes with $n, an int of the generated factory, so rows made with
different numbers do not clash on unique columns. Mirrors web/src/core/generators/php/common/samples.ts."""

import math
import re

from ....js import number_text
from .php import php_string

DATE_TIME = "\\DateTimeImmutable"


def _checks_of(column: dict, checks: list[dict]) -> list[dict]:
    return [
        check["parsed"]
        for check in checks
        if check.get("parsed") is not None and check["parsed"]["column"] == column["column"]["name"]
    ]


def _number(column: dict, checks: list[dict]) -> str:
    """A whole number that changes with $n and stays above the lower bound a CHECK sets."""
    low = 0
    for parsed in _checks_of(column, checks):
        if parsed["kind"] == "compare" and parsed["op"] in (">", ">="):
            low = max(low, math.ceil(parsed["value"]))
    return "$n" if low == 0 else f"{low} + $n"


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def sample_value(column: dict, checks: list[dict], enums: list[dict]) -> str:
    """A PHP expression for a value of the column."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    choices = next((parsed for parsed in _checks_of(column, checks) if parsed["kind"] == "in"), None)
    if choices:
        first = _text(choices["values"][0])
        if kind == "integer":
            return first
        if kind == "float":
            return first if re.search(r"[.eE]", first) else f"{first}.0"
        return php_string(first)
    if kind == "integer":
        return _number(column, checks)
    if kind == "decimal":
        scale = column_type.get("scale")
        scale = 2 if scale is None else scale
        precision = column_type.get("precision")
        integer_digits = precision - scale if precision is not None else 6
        if integer_digits <= 0:
            return php_string("0." + "5".rjust(scale, "0"))
        whole = f"$n % {10 ** min(integer_digits, 4)}"
        return f"({whole}) . {php_string('.' + '5'.ljust(scale, '0'))}" if scale > 0 else f"(string) ({whole})"
    if kind == "float":
        return f"{_number(column, checks)} + 0.5"
    if kind == "text":
        length = column_type.get("length")
        length = 40 if length is None else length
        if column_type.get("fixed"):
            return f"str_pad((string) ($n % {10 ** min(length, 9)}), {length}, '0', STR_PAD_LEFT)"
        # The column name and the number, as long as it fits; $n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["column"]["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'"{prefix}-{{$n}}"' if prefix else f"(string) ($n % {10 ** min(length, 9)})"
    if kind == "enum":
        item = next((item for item in enums if item["name"] == column_type["name"]), None)
        return php_string(item["values"][0] if item and item["values"] else "value")
    if kind == "boolean":
        return "true"
    if kind == "date":
        return f"new {DATE_TIME}(sprintf('2026-01-%02d', $n % 28 + 1))"
    if kind == "time":
        if column["php"] == DATE_TIME:
            return f"new {DATE_TIME}(sprintf('12:%02d:00', $n % 60))"
        return "sprintf('12:%02d:00', $n % 60)"
    if kind == "datetime":
        return f"new {DATE_TIME}(sprintf('2026-01-%02d 12:00:00', $n % 28 + 1))"
    if kind == "uuid":
        return "sprintf('00000000-0000-4000-8000-%012d', $n)"
    if kind == "binary":
        return "chr($n % 256)"
    if kind == "json":
        return "['n' => $n]"
    if kind == "array":
        return "[]"
    return '"value-{$n}"'


def missing_value(column: dict) -> str:
    """A key no row has, as a PHP expression, for the tests of missing rows."""
    if column["php"] == "int":
        return "999999"
    if column["php"] == "float":
        return "999999.0"
    if column["php"] == DATE_TIME:
        return f"new {DATE_TIME}('1999-01-01')"
    kind = column["column"]["type"]["kind"]
    if kind == "uuid":
        return "'00000000-0000-4000-8000-000000999999'"
    if kind == "decimal":
        return "'999999'"
    return "'missing'"
