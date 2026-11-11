//! An author as the service and its storage handle it.

use chrono::NaiveDate;
use uuid::Uuid;

/// An author as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Author {
    pub id: Uuid,
    pub name: Option<String>,
    pub email: Option<String>,
    pub born: Option<NaiveDate>,
}
