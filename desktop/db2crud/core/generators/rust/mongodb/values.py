"""Values between Rust and the documents of MongoDB, by the functions of bson_values.rs. Mirrors
web/src/core/generators/rust/mongodb/values.ts."""

from ....schema.documents import is_object_id


def _plain_name(column_type: dict) -> str:
    """The name of a plain value in the functions: `as_text` reads it, `of_text` writes it."""
    if is_object_id(column_type):
        return "object_id"
    kind = column_type["kind"]
    if kind == "integer":
        return {16: "i16", 64: "i64"}.get(column_type["bits"], "i32")
    if kind == "float":
        return "f32" if column_type["bits"] == 32 else "f64"
    names = {
        "decimal": "decimal",
        "boolean": "bool",
        "datetime": "moment",
        "uuid": "uuid",
        "binary": "bytes",
        "json": "any",
        "unknown": "any",
    }
    return names.get(kind, "text")


def _function(prefix: str, method: str, column_type: dict, nested: dict | None) -> str:
    if column_type["kind"] == "array":
        return f"bson_values::{prefix}_list({_function(prefix, method, column_type['items'], nested)})"
    if column_type["kind"] == "json" and column_type.get("fields") is not None and nested:
        return f"bson_values::{prefix}_nested({nested['path']}::{method})"
    return f"bson_values::{prefix}_{_plain_name(column_type)}"


def reads(column_type: dict, nested: dict | None) -> str:
    """The function that reads a value: `bson_values::as_text`."""
    return _function("as", "from_document", column_type, nested)


def writes(column_type: dict, nested: dict | None) -> str:
    """The function that writes a value: `bson_values::of_text`."""
    return _function("of", "to_document", column_type, nested)


def encoded(column_type: dict, value: str, nested: dict | None = None) -> str:
    """A value that is there, as a document holds it."""
    return f"{writes(column_type, nested)}(&{value})?"


_FUNCTIONS = {
    "object_id": {
        "rs": "String",
        "read": "value.as_object_id().map(|id| id.to_hex())",
        "write": "ObjectId::parse_str(value).map(Bson::ObjectId).map_err(Error::custom)",
    },
    "text": {
        "rs": "String",
        "read": "value.as_str().map(str::to_string)",
        "write": "Ok(Bson::String(value.clone()))",
    },
    "bool": {
        "rs": "bool",
        "read": "value.as_bool()",
        "write": "Ok(Bson::Boolean(*value))",
    },
    "i16": {
        "rs": "i16",
        "read": "whole(value).and_then(|number| number.try_into().ok())",
        "write": "Ok(Bson::Int32(i32::from(*value)))",
    },
    "i32": {
        "rs": "i32",
        "read": "whole(value).and_then(|number| number.try_into().ok())",
        "write": "Ok(Bson::Int32(*value))",
    },
    "i64": {
        "rs": "i64",
        "read": "whole(value)",
        "write": "Ok(Bson::Int64(*value))",
    },
    "f32": {
        "rs": "f32",
        "read": "number(value).map(|number| number as f32)",
        "write": "Ok(Bson::Double(f64::from(*value)))",
    },
    "f64": {
        "rs": "f64",
        "read": "number(value)",
        "write": "Ok(Bson::Double(*value))",
    },
    "decimal": {
        "crate": "rust_decimal",
        "rs": "rust_decimal::Decimal",
        "read": "decimal(value)",
        "write": "value.to_string().parse().map(Bson::Decimal128).map_err(Error::custom)",
    },
    "moment": {
        "crate": "chrono",
        "rs": "chrono::DateTime<chrono::Utc>",
        "read": "value.as_datetime().and_then(|moment| chrono::DateTime::from_timestamp_millis(moment.timestamp_millis()))",
        "write": "Ok(Bson::DateTime(DateTime::from_millis(value.timestamp_millis())))",
    },
    "uuid": {
        "crate": "uuid",
        "rs": "uuid::Uuid",
        "read": "binary(value).and_then(|bytes| uuid::Uuid::from_slice(bytes).ok())",
        "write": "Ok(Bson::Binary(Binary { subtype: BinarySubtype::Uuid, bytes: value.as_bytes().to_vec() }))",
    },
    "bytes": {
        "rs": "Vec<u8>",
        "read": "binary(value).cloned()",
        "write": "Ok(Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: value.clone() }))",
    },
    "any": {
        "rs": "Bson",
        "read": "Some(value.clone())",
        "write": "Ok(value.clone())",
    },
}


def value_functions(crates: set[str]) -> list[str]:
    """The functions that read and write the values of the types in use."""
    result = []
    for name, item in _FUNCTIONS.items():
        if item.get("crate") and item["crate"] not in crates:
            continue
        result += [
            "",
            f"pub fn as_{name}(value: &Bson) -> Result<{item['rs']}, Error> {{",
            f"    {item['read']}.ok_or_else(|| unexpected(value))",
            "}",
            "",
            f"pub fn of_{name}(value: &{item['rs']}) -> Result<Bson, Error> {{",
            f"    {item['write']}",
            "}",
        ]
    return result
