"""Sample values for the generated tests, as Rust expressions: each one fits its column (type, length, precision, the
CHECK constraints the rules understand) and changes with n, an i32 of the generated factory, so rows made with
different numbers do not clash on unique columns. Mirrors web/src/core/generators/rust/samples.ts."""

import math
import re

from ...js import is_number, js_string
from .entities import rs_literal
from .rust import owned


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
    value = "n" if low == 0 else f"{low} + n"
    if column["rs"] == "i64":
        return f"i64::from({value})"
    if column["rs"] == "i16":
        return f"({value}) as i16"
    return value


DATE = 'chrono::NaiveDate::from_ymd_opt(2026, 1, (n % 28 + 1) as u32).expect("a date")'


def sample_value(column: dict, checks: list[dict], enums: list[dict]) -> str:
    """A Rust expression for a value of the column."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    choices = next((parsed for parsed in _checks_of(column, checks) if parsed["kind"] == "in"), None)
    if choices:
        first = choices["values"][0]
        if is_number(first) or kind in ("integer", "decimal", "float"):
            return rs_literal(column, first)
        return owned(js_string(first))
    if kind == "integer":
        return _whole(column, checks)
    if kind == "decimal":
        scale = column_type.get("scale")
        scale = 2 if scale is None else scale
        precision = column_type.get("precision")
        integer_digits = precision - scale if precision is not None else 6
        if integer_digits <= 0:
            return f"rust_decimal::Decimal::new(5, {scale})"
        part = f"i64::from(n % {10 ** min(integer_digits, 4)})"
        if scale > 0:
            return f"rust_decimal::Decimal::new({part} * {10**scale} + {5 * 10 ** (scale - 1)}, {scale})"
        return f"rust_decimal::Decimal::from({part})"
    if kind == "float":
        whole = _whole({**column, "rs": "i32"}, checks)
        return f"({whole}) as f32 + 0.5" if column["rs"] == "f32" else f"f64::from({whole}) + 0.5"
    if kind == "text":
        length = column_type.get("length")
        length = 40 if length is None else length
        if column_type.get("fixed"):
            return f'format!("{{:0>{length}}}", n % {10 ** min(length, 9)})'
        # The column name and the number, as long as it fits; n stays below 1000 in the tests
        room = length - 4
        prefix = re.sub(r"[^a-z]", "", column["column"]["name"], flags=re.IGNORECASE).lower()[: max(0, min(room, 20))]
        return f'format!("{prefix}-{{n}}")' if prefix else f"(n % {10 ** min(length, 9)}).to_string()"
    if kind == "enum":
        values = next((item["values"] for item in enums if item["name"] == column_type["name"]), None)
        return owned(values[0] if values else "value")
    if kind == "boolean":
        return "true"
    if kind == "date":
        return DATE
    if kind == "time":
        return 'chrono::NaiveTime::from_hms_opt(12, (n % 60) as u32, 0).expect("a time")'
    if kind == "datetime":
        if column["rs"] == "chrono::NaiveDateTime":
            return f'{DATE}.and_hms_opt(12, 0, 0).expect("a time")'
        return f'{DATE}.and_hms_opt(12, 0, 0).expect("a time").and_utc().fixed_offset()'
    if kind == "uuid":
        return "uuid::Uuid::from_u128(n as u128)"
    if kind == "binary":
        return "vec![n as u8]"
    if kind == "json":
        return 'format!("{{\\"n\\": {n}}}")'
    if kind == "array":
        return '"[]".to_string()'
    return 'format!("value-{n}")'


MISSING = {
    "i64": "999999",
    "i32": "999999",
    "i16": "9999",
    "rust_decimal::Decimal": "rust_decimal::Decimal::from(999999)",
    "f64": "999999.0",
    "f32": "999999.0",
    "uuid::Uuid": "uuid::Uuid::from_u128(999999)",
    "chrono::NaiveDate": 'chrono::NaiveDate::from_ymd_opt(1999, 1, 1).expect("a date")',
    "chrono::NaiveDateTime": 'chrono::NaiveDate::from_ymd_opt(1999, 1, 1).expect("a date").and_hms_opt(0, 0, 0).expect("a time")',
    "chrono::DateTime<chrono::FixedOffset>": 'chrono::NaiveDate::from_ymd_opt(1999, 1, 1).expect("a date").and_hms_opt(0, 0, 0).expect("a time").and_utc().fixed_offset()',
    "chrono::NaiveTime": 'chrono::NaiveTime::from_hms_opt(0, 0, 1).expect("a time")',
    "bool": "false",
    "Vec<u8>": "vec![255, 255]",
}


def missing_value(column: dict) -> str:
    """A key no row has, as a Rust expression, for the tests of missing rows."""
    return MISSING.get(column["rs"], '"missing".to_string()')
