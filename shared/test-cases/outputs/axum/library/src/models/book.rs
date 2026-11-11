//! A book as the service and its storage handle it.

use chrono::NaiveDate;
use uuid::Uuid;

use crate::models::genre::Genre;

/// A book as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Book {
    pub id: Uuid,
    pub title: Option<String>,
    pub isbn: Option<String>,
    pub author_id: Option<Uuid>,
    pub genre: Option<Genre>,
    pub pages: Option<i32>,
    pub published: Option<NaiveDate>,
    pub available: Option<bool>,
}
