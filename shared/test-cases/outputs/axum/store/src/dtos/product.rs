//! Request bodies and responses of products.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};
use crate::models::product::Product;

/// Body of a request that creates or replaces a product.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductCreate {
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub stock: Option<f64>,
    #[serde(default)]
    pub active: Option<bool>,
}

impl ProductCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "sku");
        checks.not_null(json, "sku");
        checks.kind(json, "sku", JsonKind::Text);
        checks.required(json, "name");
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.not_null(json, "description");
        checks.kind(json, "description", JsonKind::Text);
        checks.required(json, "price");
        checks.not_null(json, "price");
        checks.kind(json, "price", JsonKind::Number);
        checks.required(json, "stock");
        checks.not_null(json, "stock");
        checks.kind(json, "stock", JsonKind::Number);
        checks.required(json, "active");
        checks.not_null(json, "active");
        checks.kind(json, "active", JsonKind::Boolean);
    }
}

/// Body of a request that changes part of a product: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductUpdate {
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub stock: Option<f64>,
    #[serde(default)]
    pub active: Option<bool>,
}

impl ProductUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "sku");
        checks.kind(json, "sku", JsonKind::Text);
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.not_null(json, "description");
        checks.kind(json, "description", JsonKind::Text);
        checks.not_null(json, "price");
        checks.kind(json, "price", JsonKind::Number);
        checks.not_null(json, "stock");
        checks.kind(json, "stock", JsonKind::Number);
        checks.not_null(json, "active");
        checks.kind(json, "active", JsonKind::Boolean);
    }
}

/// A product as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct ProductResponse {
    pub id: i64,
    pub sku: Option<String>,
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub price: Option<f64>,
    pub stock: Option<f64>,
    pub active: Option<bool>,
}

impl From<Product> for ProductResponse {
    fn from(item: Product) -> Self {
        Self {
            id: item.id,
            sku: item.sku,
            name: item.name,
            description: item.description,
            price: item.price,
            stock: item.stock,
            active: item.active,
        }
    }
}
