//! Where orders are kept.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;

use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::models::order::Order;

/// What a list of orders can filter by: a field that has a value must be equal to it.
#[derive(Clone, Debug, Default)]
pub struct OrderFilters {}

/// Where orders are kept. The service depends only on this trait.
#[async_trait]
pub trait OrderRepository: Send + Sync {
    /// Items equal to every filter, in order, within the window; and how many match.
    async fn list(&self, query: &ListQuery<OrderFilters>) -> Result<ListResult<Order>, ApiError>;

    /// The item with this key, or None when there is none.
    async fn get(&self, key: i64) -> Result<Option<Order>, ApiError>;

    /// Stores a new item and assigns its key; returns it as stored.
    async fn add(&self, item: Order) -> Result<Order, ApiError>;

    /// Stores the new state of an existing item and returns it.
    async fn update(&self, item: Order) -> Result<Order, ApiError>;

    /// Removes an existing item.
    async fn delete(&self, key: i64) -> Result<(), ApiError>;
}

/// Keeps orders in memory: they are lost when the application stops. Use it to try the API.
#[derive(Default)]
pub struct InMemoryOrderRepository {
    items: Mutex<BTreeMap<i64, Order>>,
    last_key: AtomicI64,
}

impl InMemoryOrderRepository {
    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<i64, Order>> {
        self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Whether an item is equal to every filter that has a value.
fn matches(_item: &Order, _filters: &OrderFilters) -> bool {
    true
}

#[async_trait]
impl OrderRepository for InMemoryOrderRepository {
    async fn list(&self, query: &ListQuery<OrderFilters>) -> Result<ListResult<Order>, ApiError> {
        let found: Vec<Order> = self.items().values().filter(|item| matches(item, &query.filters)).cloned().collect();
        let total = found.len() as u64;
        let window = found.into_iter().skip(query.offset as usize).take(query.limit.map_or(usize::MAX, |limit| limit as usize)).collect();
        Ok(ListResult { items: window, total })
    }

    async fn get(&self, key: i64) -> Result<Option<Order>, ApiError> {
        Ok(self.items().get(&key).cloned())
    }

    async fn add(&self, mut item: Order) -> Result<Order, ApiError> {
        item.id = self.last_key.fetch_add(1, Ordering::SeqCst) + 1;
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn update(&self, item: Order) -> Result<Order, ApiError> {
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn delete(&self, key: i64) -> Result<(), ApiError> {
        self.items().remove(&key);
        Ok(())
    }
}
