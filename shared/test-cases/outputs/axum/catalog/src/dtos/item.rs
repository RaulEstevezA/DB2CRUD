//! Request bodies and responses of items.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};
use crate::models::item::Item;

/// Body of a request that creates or replaces an item.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemCreate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub price: Option<Decimal>,
    #[serde(rename = "supplierEmail", default)]
    pub supplier_email: Option<String>,
    #[serde(rename = "categoryId", default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub stock: Option<i32>,
}

impl ItemCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "name");
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.length(json, "name", Some(3), Some(120));
        checks.required(json, "price");
        checks.not_null(json, "price");
        checks.kind(json, "price", JsonKind::Number);
        checks.range(json, "price", Some("0"), None, false, false);
        checks.required(json, "supplierEmail");
        checks.not_null(json, "supplierEmail");
        checks.kind(json, "supplierEmail", JsonKind::Text);
        checks.email(json, "supplierEmail");
        checks.required(json, "categoryId");
        checks.not_null(json, "categoryId");
        checks.kind(json, "categoryId", JsonKind::Whole);
        checks.required(json, "stock");
        checks.not_null(json, "stock");
        checks.kind(json, "stock", JsonKind::Whole);
        checks.range(json, "stock", Some("0"), None, false, false);
    }
}

/// Body of a request that changes part of an item: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub price: Option<Decimal>,
    #[serde(rename = "supplierEmail", default)]
    pub supplier_email: Option<String>,
    #[serde(rename = "categoryId", default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub stock: Option<i32>,
}

impl ItemUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.length(json, "name", Some(3), Some(120));
        checks.not_null(json, "price");
        checks.kind(json, "price", JsonKind::Number);
        checks.range(json, "price", Some("0"), None, false, false);
        checks.not_null(json, "supplierEmail");
        checks.kind(json, "supplierEmail", JsonKind::Text);
        checks.email(json, "supplierEmail");
        checks.not_null(json, "categoryId");
        checks.kind(json, "categoryId", JsonKind::Whole);
        checks.not_null(json, "stock");
        checks.kind(json, "stock", JsonKind::Whole);
        checks.range(json, "stock", Some("0"), None, false, false);
    }
}

/// An item as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct ItemResponse {
    pub id: i64,
    pub name: Option<String>,
    pub price: Option<Decimal>,
    #[serde(rename = "supplierEmail")]
    pub supplier_email: Option<String>,
    #[serde(rename = "categoryId")]
    pub category_id: Option<i64>,
    pub stock: Option<i32>,
}

impl From<Item> for ItemResponse {
    fn from(item: Item) -> Self {
        Self {
            id: item.id,
            name: item.name,
            price: item.price,
            supplier_email: item.supplier_email,
            category_id: item.category_id,
            stock: item.stock,
        }
    }
}
