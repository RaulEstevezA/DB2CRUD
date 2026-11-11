//! Request bodies and responses of authors.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::common::body::{Checks, JsonKind};
use crate::models::author::Author;

/// Body of a request that creates or replaces an author.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorCreate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub born: Option<NaiveDate>,
}

impl AuthorCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "name");
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.length(json, "name", Some(2), Some(120));
        checks.kind(json, "email", JsonKind::Text);
        checks.email(json, "email");
        checks.kind(json, "born", JsonKind::Text);
        checks.pattern(json, "born", "^\\d{4}-\\d{2}-\\d{2}$");
    }
}

/// Body of a request that changes part of an author: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub born: Option<NaiveDate>,
}

impl AuthorUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "name");
        checks.kind(json, "name", JsonKind::Text);
        checks.length(json, "name", Some(2), Some(120));
        checks.kind(json, "email", JsonKind::Text);
        checks.email(json, "email");
        checks.kind(json, "born", JsonKind::Text);
        checks.pattern(json, "born", "^\\d{4}-\\d{2}-\\d{2}$");
    }
}

/// An author as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct AuthorResponse {
    pub id: Uuid,
    pub name: Option<String>,
    pub email: Option<String>,
    pub born: Option<NaiveDate>,
}

impl From<Author> for AuthorResponse {
    fn from(item: Author) -> Self {
        Self {
            id: item.id,
            name: item.name,
            email: item.email,
            born: item.born,
        }
    }
}
