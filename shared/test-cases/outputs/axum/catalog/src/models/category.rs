//! A category as the service and its storage handle it.

/// A category as the service and its storage handle it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Category {
    pub id: i64,
    pub name: Option<String>,
    pub parent_id: Option<i64>,
}
