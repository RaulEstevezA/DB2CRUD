//! An item as the service and its storage handle it.

use rust_decimal::Decimal;

/// An item as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    pub id: i64,
    pub name: Option<String>,
    pub price: Option<Decimal>,
    pub supplier_email: Option<String>,
    pub category_id: Option<i64>,
    pub stock: Option<i32>,
}
