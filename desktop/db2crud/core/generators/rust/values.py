"""Rust expressions of values: the literal of a default, and the current time. Mirrors
web/src/core/generators/rust/values.ts."""

import re

from ...js import js_string
from .rust import rs_string


def rs_literal(column: dict, value) -> str:
    """A literal of a default, as a Rust expression of the column's type."""
    if isinstance(value, bool):
        return "true" if value else "false"
    text = js_string(value)
    rs = column["rs"]
    if rs in ("i64", "i32", "i16", "bool"):
        return text
    if rs in ("f64", "f32"):
        return text if re.search(r"[.eE]", text) else f"{text}.0"
    if rs == "String":
        return f"{rs_string(text)}.to_string()"
    if rs == "Vec<u8>":
        return f"{rs_string(text)}.as_bytes().to_vec()"
    return f"{rs_string(text)}.parse::<{rs}>().expect({rs_string('a ' + rs)})"


NOW = {
    "chrono::DateTime<chrono::FixedOffset>": "chrono::Utc::now().fixed_offset()",
    "chrono::NaiveDateTime": "chrono::Utc::now().naive_utc()",
    "chrono::NaiveDate": "chrono::Utc::now().date_naive()",
    "chrono::NaiveTime": "chrono::Utc::now().time()",
}


def now_of(column: dict) -> str | None:
    """The current time, as a value of the column's type."""
    return NOW.get(column["rs"])
