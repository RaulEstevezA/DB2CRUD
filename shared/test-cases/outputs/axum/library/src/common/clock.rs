//! The time the server writes, in UTC.

use chrono::{DateTime, NaiveDate, SubsecRound, Utc};

/// Now, to the microsecond: what databases keep, so a later read gives the same value.
pub fn now() -> DateTime<Utc> {
    Utc::now().trunc_subsecs(6)
}

pub fn today() -> NaiveDate {
    Utc::now().date_naive()
}

/// Now as ISO 8601 text, for a text field the server fills.
pub fn text() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
