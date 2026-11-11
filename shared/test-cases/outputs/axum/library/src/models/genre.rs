//! Values of Genre.

use serde::{Deserialize, Serialize};

/// Values of Genre, with the value each one has in JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Genre {
    #[serde(rename = "novel")]
    Novel,

    #[serde(rename = "essay")]
    Essay,

    #[serde(rename = "poetry")]
    Poetry,

    #[serde(rename = "science")]
    Science,
}

impl Genre {
    /// The value in JSON.
    pub fn value(self) -> &'static str {
        match self {
            Self::Novel => "novel",
            Self::Essay => "essay",
            Self::Poetry => "poetry",
            Self::Science => "science",
        }
    }

    /// The variant with this value in JSON, or None when none has it.
    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "novel" => Some(Self::Novel),
            "essay" => Some(Self::Essay),
            "poetry" => Some(Self::Poetry),
            "science" => Some(Self::Science),
            _ => None,
        }
    }
}
