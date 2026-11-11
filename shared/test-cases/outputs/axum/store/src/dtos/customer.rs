//! Request bodies and responses of customers.

use chrono::DateTime;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};
use crate::models::address::Address;
use crate::models::customer::Customer;

/// Body of a request that creates or replaces a customer.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomerCreate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address: Option<Address>,
}

impl CustomerCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "name");
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.required(json, "email");
        checks.not_null(json, "email");
        checks.kind(json, "email", JsonKind::Text);
        checks.required(json, "password");
        checks.not_null(json, "password");
        checks.kind(json, "password", JsonKind::Text);
        checks.not_null(json, "phone");
        checks.kind(json, "phone", JsonKind::Text);
        checks.required(json, "address");
        checks.not_null(json, "address");
        checks.kind(json, "address", JsonKind::Object);
        checks.nested(json, "address", Address::rules);
    }
}

/// Body of a request that changes part of a customer: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomerUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address: Option<Address>,
}

impl CustomerUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.not_null(json, "email");
        checks.kind(json, "email", JsonKind::Text);
        checks.not_null(json, "password");
        checks.kind(json, "password", JsonKind::Text);
        checks.not_null(json, "phone");
        checks.kind(json, "phone", JsonKind::Text);
        checks.not_null(json, "address");
        checks.kind(json, "address", JsonKind::Object);
        checks.nested(json, "address", Address::rules);
    }
}

/// A customer as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct CustomerResponse {
    pub id: i64,
    pub name: Option<String>,
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    pub address: Option<Address>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<DateTime<Utc>>,
}

impl From<Customer> for CustomerResponse {
    fn from(item: Customer) -> Self {
        Self {
            id: item.id,
            name: item.name,
            email: item.email,
            phone: item.phone,
            address: item.address,
            created_at: item.created_at,
        }
    }
}
