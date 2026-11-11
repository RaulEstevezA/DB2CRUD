//! A product as the service and its storage handle it.

/// A product as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Product {
    pub id: i64,
    pub sku: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub price: Option<f64>,
    pub stock: Option<f64>,
    pub active: Option<bool>,
}
