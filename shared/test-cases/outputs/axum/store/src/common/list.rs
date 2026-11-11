//! What a list asks a repository for, and what it gets back.

use std::cmp::Ordering;

use serde::Serialize;

/// A list: the filters of its resource, an order by a JSON field name and a window.
#[derive(Clone, Debug)]
pub struct ListQuery<F> {
    pub filters: F,
    pub sort_field: Option<String>,
    pub descending: bool,
    pub offset: u64,
    pub limit: Option<u64>,
}

impl<F> ListQuery<F> {
    /// "-createdAt" sorts by createdAt in descending order.
    pub fn new(filters: F, sort: Option<String>, offset: u64, limit: Option<u64>) -> Self {
        let descending = sort.as_deref().is_some_and(|sort| sort.starts_with('-'));
        let sort_field = sort.map(|sort| sort.trim_start_matches('-').to_string());
        Self { filters, sort_field, descending, offset, limit }
    }
}

/// A window of items and how many match, whatever the window.
pub struct ListResult<T> {
    pub items: Vec<T>,
    pub total: u64,
}

/// One page of a list, as the API returns it.
#[derive(Serialize)]
pub struct PageResponse<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub page: u64,
    pub size: u64,
}

/// Orders two values of a field: the ones without a value go last, whatever the order.
pub fn order_values<T: PartialOrd>(a: &Option<T>, b: &Option<T>, descending: bool) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => {
            let order = a.partial_cmp(b).unwrap_or(Ordering::Equal);
            if descending { order.reverse() } else { order }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}
