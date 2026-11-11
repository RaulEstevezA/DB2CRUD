//! Where categories are kept.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;

use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::models::category::Category;

/// What a list of categories can filter by: a field that has a value must be equal to it.
#[derive(Clone, Debug, Default)]
pub struct CategoryFilters {}

/// Where categories are kept. The service depends only on this trait.
#[async_trait]
pub trait CategoryRepository: Send + Sync {
    /// Items equal to every filter, in order, within the window; and how many match.
    async fn list(&self, query: &ListQuery<CategoryFilters>) -> Result<ListResult<Category>, ApiError>;

    /// The item with this key, or None when there is none.
    async fn get(&self, key: i64) -> Result<Option<Category>, ApiError>;

    /// Stores a new item and assigns its key; returns it as stored.
    async fn add(&self, item: Category) -> Result<Category, ApiError>;

    /// Stores the new state of an existing item and returns it.
    async fn update(&self, item: Category) -> Result<Category, ApiError>;

    /// Removes an existing item.
    async fn delete(&self, key: i64) -> Result<(), ApiError>;
}

/// Keeps categories in memory: they are lost when the application stops. Use it to try the API.
#[derive(Default)]
pub struct InMemoryCategoryRepository {
    items: Mutex<BTreeMap<i64, Category>>,
    last_key: AtomicI64,
}

impl InMemoryCategoryRepository {
    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<i64, Category>> {
        self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Whether an item is equal to every filter that has a value.
fn matches(_item: &Category, _filters: &CategoryFilters) -> bool {
    true
}

#[async_trait]
impl CategoryRepository for InMemoryCategoryRepository {
    async fn list(&self, query: &ListQuery<CategoryFilters>) -> Result<ListResult<Category>, ApiError> {
        let found: Vec<Category> = self.items().values().filter(|item| matches(item, &query.filters)).cloned().collect();
        let total = found.len() as u64;
        let window = found.into_iter().skip(query.offset as usize).take(query.limit.map_or(usize::MAX, |limit| limit as usize)).collect();
        Ok(ListResult { items: window, total })
    }

    async fn get(&self, key: i64) -> Result<Option<Category>, ApiError> {
        Ok(self.items().get(&key).cloned())
    }

    async fn add(&self, mut item: Category) -> Result<Category, ApiError> {
        item.id = self.last_key.fetch_add(1, Ordering::SeqCst) + 1;
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn update(&self, item: Category) -> Result<Category, ApiError> {
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn delete(&self, key: i64) -> Result<(), ApiError> {
        self.items().remove(&key);
        Ok(())
    }
}
