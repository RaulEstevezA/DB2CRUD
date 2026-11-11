//! Request bodies and responses of categories.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::body::{Checks, JsonKind};
use crate::models::category::Category;

/// Body of a request that creates or replaces a category.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryCreate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<i64>,
}

impl CategoryCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "name");
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.length(json, "name", Some(1), Some(80));
        checks.kind(json, "parentId", JsonKind::Whole);
    }
}

/// Body of a request that changes part of a category: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<i64>,
}

impl CategoryUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.length(json, "name", Some(1), Some(80));
        checks.kind(json, "parentId", JsonKind::Whole);
    }
}

/// A category as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct CategoryResponse {
    pub id: i64,
    pub name: Option<String>,
    #[serde(rename = "parentId", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<i64>,
}

impl From<Category> for CategoryResponse {
    fn from(item: Category) -> Self {
        Self {
            id: item.id,
            name: item.name,
            parent_id: item.parent_id,
        }
    }
}
