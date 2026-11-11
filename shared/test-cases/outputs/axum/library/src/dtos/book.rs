//! Request bodies and responses of books.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::common::body::{Checks, JsonKind};
use crate::models::book::Book;
use crate::models::genre::Genre;

/// Body of a request that creates or replaces a book.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookCreate {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub isbn: Option<String>,
    #[serde(rename = "authorId", default)]
    pub author_id: Option<Uuid>,
    #[serde(default)]
    pub genre: Option<Genre>,
    #[serde(default)]
    pub pages: Option<i32>,
    #[serde(default)]
    pub published: Option<NaiveDate>,
    #[serde(default)]
    pub available: Option<bool>,
}

impl BookCreate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.required(json, "title");
        checks.not_null(json, "title");
        checks.kind(json, "title", JsonKind::Text);
        checks.length(json, "title", Some(1), Some(200));
        checks.required(json, "isbn");
        checks.not_null(json, "isbn");
        checks.kind(json, "isbn", JsonKind::Text);
        checks.pattern(json, "isbn", "^[0-9]{13}$");
        checks.required(json, "authorId");
        checks.not_null(json, "authorId");
        checks.kind(json, "authorId", JsonKind::Text);
        checks.required(json, "genre");
        checks.not_null(json, "genre");
        checks.kind(json, "genre", JsonKind::Text);
        checks.required(json, "pages");
        checks.not_null(json, "pages");
        checks.kind(json, "pages", JsonKind::Whole);
        checks.range(json, "pages", Some("1"), Some("5000"), false, false);
        checks.kind(json, "published", JsonKind::Text);
        checks.pattern(json, "published", "^\\d{4}-\\d{2}-\\d{2}$");
        checks.not_null(json, "available");
        checks.kind(json, "available", JsonKind::Boolean);
    }
}

/// Body of a request that changes part of a book: only the fields sent change.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookUpdate {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub isbn: Option<String>,
    #[serde(rename = "authorId", default)]
    pub author_id: Option<Uuid>,
    #[serde(default)]
    pub genre: Option<Genre>,
    #[serde(default)]
    pub pages: Option<i32>,
    #[serde(default)]
    pub published: Option<NaiveDate>,
    #[serde(default)]
    pub available: Option<bool>,
}

impl BookUpdate {
    /// What the body must meet, checked on its JSON before it is read.
    pub fn rules(checks: &mut Checks, json: &Map<String, Value>) {
        checks.not_null(json, "title");
        checks.kind(json, "title", JsonKind::Text);
        checks.length(json, "title", Some(1), Some(200));
        checks.not_null(json, "isbn");
        checks.kind(json, "isbn", JsonKind::Text);
        checks.pattern(json, "isbn", "^[0-9]{13}$");
        checks.not_null(json, "authorId");
        checks.kind(json, "authorId", JsonKind::Text);
        checks.not_null(json, "genre");
        checks.kind(json, "genre", JsonKind::Text);
        checks.not_null(json, "pages");
        checks.kind(json, "pages", JsonKind::Whole);
        checks.range(json, "pages", Some("1"), Some("5000"), false, false);
        checks.kind(json, "published", JsonKind::Text);
        checks.pattern(json, "published", "^\\d{4}-\\d{2}-\\d{2}$");
        checks.not_null(json, "available");
        checks.kind(json, "available", JsonKind::Boolean);
    }
}

/// A book as the API returns it: everything but what clients only send.
#[derive(Clone, Debug, Serialize)]
pub struct BookResponse {
    pub id: Uuid,
    pub title: Option<String>,
    pub isbn: Option<String>,
    #[serde(rename = "authorId")]
    pub author_id: Option<Uuid>,
    pub genre: Option<Genre>,
    pub pages: Option<i32>,
    pub published: Option<NaiveDate>,
    pub available: Option<bool>,
}

impl From<Book> for BookResponse {
    fn from(item: Book) -> Self {
        Self {
            id: item.id,
            title: item.title,
            isbn: item.isbn,
            author_id: item.author_id,
            genre: item.genre,
            pages: item.pages,
            published: item.published,
            available: item.available,
        }
    }
}
