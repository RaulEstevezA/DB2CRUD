//! Where items are kept.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;

use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::models::item::Item;

/// What a list of items can filter by: a field that has a value must be equal to it.
#[derive(Clone, Debug, Default)]
pub struct ItemFilters {}

/// Where items are kept. The service depends only on this trait.
#[async_trait]
pub trait ItemRepository: Send + Sync {
    /// Items equal to every filter, in order, within the window; and how many match.
    async fn list(&self, query: &ListQuery<ItemFilters>) -> Result<ListResult<Item>, ApiError>;

    /// The item with this key, or None when there is none.
    async fn get(&self, key: i64) -> Result<Option<Item>, ApiError>;

    /// Stores a new item and assigns its key; returns it as stored.
    async fn add(&self, item: Item) -> Result<Item, ApiError>;

    /// Stores the new state of an existing item and returns it.
    async fn update(&self, item: Item) -> Result<Item, ApiError>;

    /// Removes an existing item.
    async fn delete(&self, key: i64) -> Result<(), ApiError>;
}

/// Keeps items in memory: they are lost when the application stops. Use it to try the API.
#[derive(Default)]
pub struct InMemoryItemRepository {
    items: Mutex<BTreeMap<i64, Item>>,
    last_key: AtomicI64,
}

impl InMemoryItemRepository {
    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<i64, Item>> {
        self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Whether an item is equal to every filter that has a value.
fn matches(_item: &Item, _filters: &ItemFilters) -> bool {
    true
}

#[async_trait]
impl ItemRepository for InMemoryItemRepository {
    async fn list(&self, query: &ListQuery<ItemFilters>) -> Result<ListResult<Item>, ApiError> {
        let found: Vec<Item> = self.items().values().filter(|item| matches(item, &query.filters)).cloned().collect();
        let total = found.len() as u64;
        let window = found.into_iter().skip(query.offset as usize).take(query.limit.map_or(usize::MAX, |limit| limit as usize)).collect();
        Ok(ListResult { items: window, total })
    }

    async fn get(&self, key: i64) -> Result<Option<Item>, ApiError> {
        Ok(self.items().get(&key).cloned())
    }

    async fn add(&self, mut item: Item) -> Result<Item, ApiError> {
        item.id = self.last_key.fetch_add(1, Ordering::SeqCst) + 1;
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn update(&self, item: Item) -> Result<Item, ApiError> {
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn delete(&self, key: i64) -> Result<(), ApiError> {
        self.items().remove(&key);
        Ok(())
    }
}
