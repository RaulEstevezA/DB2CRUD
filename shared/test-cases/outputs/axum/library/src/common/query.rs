//! Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use uuid::Uuid;

use crate::common::error::ApiError;

/// The values of a query string or of the parameters of a path, by name.
pub type Params = HashMap<String, String>;

pub fn long_key(params: &Params, name: &str) -> Result<i64, ApiError> {
    params.get(name).and_then(|text| text.parse().ok()).ok_or_else(|| ApiError::invalid(name, "Must be a whole number"))
}

pub fn uuid_key(params: &Params, name: &str) -> Result<Uuid, ApiError> {
    params.get(name).and_then(|text| parse_uuid(text)).ok_or_else(|| ApiError::invalid(name, "Must be a UUID"))
}

pub fn text_key(params: &Params, name: &str) -> Result<String, ApiError> {
    params.get(name).cloned().ok_or_else(|| ApiError::invalid(name, "Is missing"))
}

/// A whole number of the query string within its limits; the default when it is not there.
pub fn int_query(query: &Params, name: &str, default: u64, min: u64, max: Option<u64>) -> Result<u64, ApiError> {
    let Some(text) = query.get(name) else {
        return Ok(default);
    };
    match text.parse::<u64>() {
        Ok(value) if value >= min && max.is_none_or(|max| value <= max) => Ok(value),
        _ => Err(ApiError::invalid(name, "Must be a whole number within its limits")),
    }
}

/// A filter of the query string read with its type, or None when it is not there; a malformed one is a 400.
pub fn filter<T>(query: &Params, name: &str, parse: impl Fn(&str) -> Option<T>) -> Result<Option<T>, ApiError> {
    match query.get(name) {
        None => Ok(None),
        Some(text) => parse(text).map(Some).ok_or_else(|| ApiError::invalid(name, "Has the wrong format")),
    }
}

/// A value of the query string that must be one of the choices.
pub fn choice_query(query: &Params, name: &str, choices: &[&str]) -> Result<Option<String>, ApiError> {
    match query.get(name) {
        None => Ok(None),
        Some(text) if choices.contains(&text.as_str()) => Ok(Some(text.clone())),
        Some(_) => Err(ApiError::invalid(name, format!("Must be one of: {}", choices.join(", ")))),
    }
}

/// A UUID written as 8-4-4-4-12 hexadecimal digits.
pub fn parse_uuid(text: &str) -> Option<Uuid> {
    let canonical = text.len() == 36 && text.chars().enumerate().all(|(index, char)| if [8, 13, 18, 23].contains(&index) { char == '-' } else { char.is_ascii_hexdigit() });
    if canonical { Uuid::parse_str(text).ok() } else { None }
}

pub fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}

pub fn parse_date_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|value| value.with_timezone(&Utc))
}
