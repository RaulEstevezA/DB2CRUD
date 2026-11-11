//! An order as the service and its storage handle it.

use chrono::DateTime;
use chrono::Utc;

use crate::models::order_line::OrderLine;
use crate::models::order_status::OrderStatus;

/// An order as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Order {
    pub id: i64,
    pub customer_id: Option<i64>,
    pub lines: Option<Vec<OrderLine>>,
    pub status: Option<OrderStatus>,
    pub total: Option<f64>,
    pub notes: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}
