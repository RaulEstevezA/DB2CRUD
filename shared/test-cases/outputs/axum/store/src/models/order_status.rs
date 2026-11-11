//! Values of OrderStatus.

use serde::{Deserialize, Serialize};

/// Values of OrderStatus, with the value each one has in JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum OrderStatus {
    #[serde(rename = "pending")]
    Pending,

    #[serde(rename = "paid")]
    Paid,

    #[serde(rename = "shipped")]
    Shipped,

    #[serde(rename = "cancelled")]
    Cancelled,
}

impl OrderStatus {
    /// The value in JSON.
    pub fn value(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Paid => "paid",
            Self::Shipped => "shipped",
            Self::Cancelled => "cancelled",
        }
    }

    /// The variant with this value in JSON, or None when none has it.
    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "paid" => Some(Self::Paid),
            "shipped" => Some(Self::Shipped),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}
