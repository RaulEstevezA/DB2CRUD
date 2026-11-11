//! OrderLine, embedded in the resources that hold it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};

/// OrderLine, embedded in the resources that hold it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderLine {
    #[serde(rename = "productId", default)]
    pub product_id: Option<i64>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(rename = "unitPrice", default)]
    pub unit_price: Option<f64>,
}

impl OrderLine {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "productId");
        checks.not_null(json, "productId");
        checks.kind(json, "productId", JsonKind::Whole);
        checks.required(json, "quantity");
        checks.not_null(json, "quantity");
        checks.kind(json, "quantity", JsonKind::Number);
        checks.required(json, "unitPrice");
        checks.not_null(json, "unitPrice");
        checks.kind(json, "unitPrice", JsonKind::Number);
    }
}
