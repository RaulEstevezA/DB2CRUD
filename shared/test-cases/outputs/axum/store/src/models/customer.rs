//! A customer as the service and its storage handle it.

use chrono::DateTime;
use chrono::Utc;

use crate::models::address::Address;

/// A customer as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Customer {
    pub id: i64,
    pub name: Option<String>,
    pub email: Option<String>,
    pub password: Option<String>,
    pub phone: Option<String>,
    pub address: Option<Address>,
    pub created_at: Option<DateTime<Utc>>,
}
