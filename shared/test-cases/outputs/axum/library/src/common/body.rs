//! Reading request bodies: a JSON object that meets the rules of its type, checked before it is read.

use std::collections::BTreeSet;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::common::error::{ApiError, ErrorDetail};

/// A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not).
pub struct Body<T> {
    pub value: T,
    sent: BTreeSet<String>,
}

impl<T> Body<T> {
    pub fn has(&self, field: &str) -> bool {
        self.sent.contains(field)
    }
}

/// The kinds of JSON value a field can hold.
#[derive(Clone, Copy, Debug)]
pub enum JsonKind {
    Text,
    Whole,
    Number,
    Boolean,
    List,
    Object,
}

/// The problems of a request body, by field. Embedded objects add their path: `address.street`.
#[derive(Default)]
pub struct Checks {
    problems: Vec<ErrorDetail>,
    prefix: String,
}

impl Checks {
    pub fn fail(&mut self, field: &str, message: &str) {
        self.problems.push(ErrorDetail { field: format!("{}{field}", self.prefix), message: message.to_string() });
    }

    pub fn required(&mut self, json: &Map<String, Value>, field: &str) {
        if !json.contains_key(field) {
            self.fail(field, "The field is required");
        }
    }

    pub fn not_null(&mut self, json: &Map<String, Value>, field: &str) {
        if json.get(field).is_some_and(Value::is_null) {
            self.fail(field, "The field must not be null");
        }
    }

    /// The value has the kind of the field; null is left to not_null.
    pub fn kind(&mut self, json: &Map<String, Value>, field: &str, kind: JsonKind) {
        let Some(value) = json.get(field).filter(|value| !value.is_null()) else {
            return;
        };
        let valid = match kind {
            JsonKind::Text => value.is_string(),
            JsonKind::Whole => value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|number| number.fract() == 0.0),
            JsonKind::Number => value.is_number(),
            JsonKind::Boolean => value.is_boolean(),
            JsonKind::List => value.is_array(),
            JsonKind::Object => value.is_object(),
        };
        if !valid {
            self.fail(field, &format!("Must be {}", format!("{kind:?}").to_lowercase()));
        }
    }

    pub fn length(&mut self, json: &Map<String, Value>, field: &str, min: Option<usize>, max: Option<usize>) {
        let Some(text) = json.get(field).and_then(Value::as_str) else {
            return;
        };
        // Counted as JavaScript counts: in UTF-16 units
        let length = text.encode_utf16().count();
        if min.is_some_and(|min| length < min) || max.is_some_and(|max| length > max) {
            self.fail(field, "Has a length out of its limits");
        }
    }

    pub fn count(&mut self, json: &Map<String, Value>, field: &str, min: Option<usize>, max: Option<usize>) {
        let Some(list) = json.get(field).and_then(Value::as_array) else {
            return;
        };
        if min.is_some_and(|min| list.len() < min) || max.is_some_and(|max| list.len() > max) {
            self.fail(field, "Has a number of items out of its limits");
        }
    }

    pub fn range(&mut self, json: &Map<String, Value>, field: &str, min: Option<&str>, max: Option<&str>, min_exclusive: bool, max_exclusive: bool) {
        let Some(number) = json.get(field).filter(|value| value.is_number()).and_then(|value| Decimal::from_str(&value.to_string()).ok().or_else(|| value.as_f64().and_then(|n| Decimal::try_from(n).ok()))) else {
            return;
        };
        let below = min.and_then(|min| Decimal::from_str(min).ok()).is_some_and(|min| number < min || (min_exclusive && number == min));
        let above = max.and_then(|max| Decimal::from_str(max).ok()).is_some_and(|max| number > max || (max_exclusive && number == max));
        if below || above {
            self.fail(field, "Is out of its range");
        }
    }

    /// The text matches the expression somewhere, as "pattern" reads it in openapi.yaml.
    pub fn pattern(&mut self, json: &Map<String, Value>, field: &str, pattern: &str) {
        let Some(text) = json.get(field).and_then(Value::as_str) else {
            return;
        };
        // An expression this engine cannot read checks nothing, rather than reject every value
        let Ok(regex) = fancy_regex::Regex::new(pattern) else {
            return;
        };
        if !regex.is_match(text).unwrap_or(false) {
            self.fail(field, "Has the wrong format");
        }
    }

    pub fn email(&mut self, json: &Map<String, Value>, field: &str) {
        let Some(text) = json.get(field).and_then(Value::as_str) else {
            return;
        };
        let mut parts = text.split('@');
        let valid = matches!((parts.next(), parts.next(), parts.next()), (Some(user), Some(domain), None) if !user.is_empty() && !domain.is_empty() && !text.contains(char::is_whitespace));
        if !valid {
            self.fail(field, "Must be an email address");
        }
    }

    /// The rules of an embedded object, with its path before each field.
    pub fn nested(&mut self, json: &Map<String, Value>, field: &str, rules: fn(&mut Checks, &Map<String, Value>)) {
        if let Some(inner) = json.get(field).and_then(Value::as_object) {
            let prefix = format!("{}{field}.", self.prefix);
            self.run(prefix, inner, rules);
        }
    }

    /// The rules of each embedded object of a list.
    pub fn each(&mut self, json: &Map<String, Value>, field: &str, rules: fn(&mut Checks, &Map<String, Value>)) {
        let Some(list) = json.get(field).and_then(Value::as_array) else {
            return;
        };
        for (index, item) in list.iter().enumerate() {
            if let Some(inner) = item.as_object() {
                let prefix = format!("{}{field}[{index}].", self.prefix);
                self.run(prefix, inner, rules);
            }
        }
    }

    fn run(&mut self, prefix: String, json: &Map<String, Value>, rules: fn(&mut Checks, &Map<String, Value>)) {
        let mut inner = Checks { problems: Vec::new(), prefix };
        rules(&mut inner, json);
        self.problems.append(&mut inner.problems);
    }
}

/// Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the
/// contract does not describe.
pub fn read_body<T: DeserializeOwned>(bytes: &[u8], rules: fn(&mut Checks, &Map<String, Value>)) -> Result<Body<T>, ApiError> {
    let json: Value = serde_json::from_slice(bytes).map_err(|_| ApiError::invalid("", "The body is not valid JSON"))?;
    let Some(object) = json.as_object() else {
        return Err(ApiError::invalid("", "The body must be a JSON object"));
    };
    let mut checks = Checks::default();
    rules(&mut checks, object);
    if !checks.problems.is_empty() {
        return Err(ApiError::invalid_body(checks.problems));
    }
    let sent = object.keys().cloned().collect();
    let value = serde_json::from_value(json).map_err(|error| ApiError::invalid("", error.to_string()))?;
    Ok(Body { value, sent })
}
