//! Request bodies and responses of orders.

use chrono::DateTime;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};
use crate::models::order::Order;
use crate::models::order_line::OrderLine;
use crate::models::order_status::OrderStatus;

/// Body of a request that creates or replaces an order.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderCreate {
    #[serde(rename = "customerId", default)]
    pub customer_id: Option<i64>,
    #[serde(default)]
    pub lines: Option<Vec<OrderLine>>,
    #[serde(default)]
    pub status: Option<OrderStatus>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl OrderCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "customerId");
        checks.not_null(json, "customerId");
        checks.kind(json, "customerId", JsonKind::Whole);
        checks.required(json, "lines");
        checks.not_null(json, "lines");
        checks.kind(json, "lines", JsonKind::List);
        checks.each(json, "lines", OrderLine::rules);
        checks.required(json, "status");
        checks.not_null(json, "status");
        checks.kind(json, "status", JsonKind::Text);
        checks.required(json, "total");
        checks.not_null(json, "total");
        checks.kind(json, "total", JsonKind::Number);
        checks.kind(json, "notes", JsonKind::Text);
    }
}

/// Body of a request that changes part of an order: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderUpdate {
    #[serde(rename = "customerId", default)]
    pub customer_id: Option<i64>,
    #[serde(default)]
    pub lines: Option<Vec<OrderLine>>,
    #[serde(default)]
    pub status: Option<OrderStatus>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl OrderUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "customerId");
        checks.kind(json, "customerId", JsonKind::Whole);
        checks.not_null(json, "lines");
        checks.kind(json, "lines", JsonKind::List);
        checks.each(json, "lines", OrderLine::rules);
        checks.not_null(json, "status");
        checks.kind(json, "status", JsonKind::Text);
        checks.not_null(json, "total");
        checks.kind(json, "total", JsonKind::Number);
        checks.kind(json, "notes", JsonKind::Text);
    }
}

/// An order as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct OrderResponse {
    pub id: i64,
    #[serde(rename = "customerId")]
    pub customer_id: Option<i64>,
    pub lines: Option<Vec<OrderLine>>,
    pub status: Option<OrderStatus>,
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl From<Order> for OrderResponse {
    fn from(item: Order) -> Self {
        Self {
            id: item.id,
            customer_id: item.customer_id,
            lines: item.lines,
            status: item.status,
            total: item.total,
            notes: item.notes,
            created_at: item.created_at,
            updated_at: item.updated_at,
        }
    }
}
