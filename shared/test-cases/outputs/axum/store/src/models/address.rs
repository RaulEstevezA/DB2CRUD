//! Address, embedded in the resources that hold it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};

/// Address, embedded in the resources that hold it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Address {
    #[serde(default)]
    pub street: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(rename = "postalCode", default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
}

impl Address {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "street");
        checks.not_null(json, "street");
        checks.kind(json, "street", JsonKind::Text);
        checks.required(json, "city");
        checks.not_null(json, "city");
        checks.kind(json, "city", JsonKind::Text);
        checks.required(json, "postalCode");
        checks.not_null(json, "postalCode");
        checks.kind(json, "postalCode", JsonKind::Text);
        checks.required(json, "country");
        checks.not_null(json, "country");
        checks.kind(json, "country", JsonKind::Text);
    }
}
