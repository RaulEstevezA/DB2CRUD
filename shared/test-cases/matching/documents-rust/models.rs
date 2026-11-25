use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Level {
    #[serde(rename = "basic")]
    Basic,
    #[serde(rename = "gold")]
    Gold,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum LineStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "sent")]
    Sent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Address {
    pub street: String,
    pub zip_code: String,
    pub location: Option<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Customer {
    pub id: String,
    pub email: String,
    pub level: Option<Level>,
    pub since: DateTime<Utc>,
    pub address: Address,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Discount {
    pub reason: String,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderLine {
    pub id: Option<String>,
    pub sku: String,
    pub quantity: i32,
    pub price: Decimal,
    pub status: Option<LineStatus>,
    pub discounts: Vec<Discount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shipping {
    pub carrier: String,
    pub sent_on: NaiveDate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub code: String,
    pub lines: Vec<OrderLine>,
    pub shipping: Option<Shipping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Parcel {
    pub weight: f64,
    pub size: String,
    pub fragile: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shipment {
    pub id: String,
    pub parcel: Parcel,
    pub stops: Vec<String>,
}
