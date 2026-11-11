//! Where authors are kept.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use uuid::Uuid;

use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::models::author::Author;

/// What a list of authors can filter by: a field that has a value must be equal to it.
#[derive(Clone, Debug, Default)]
pub struct AuthorFilters {}

/// Where authors are kept. The service depends only on this trait.
#[async_trait]
pub trait AuthorRepository: Send + Sync {
    /// Items equal to every filter, in order, within the window; and how many match.
    async fn list(&self, query: &ListQuery<AuthorFilters>) -> Result<ListResult<Author>, ApiError>;

    /// The item with this key, or None when there is none.
    async fn get(&self, key: Uuid) -> Result<Option<Author>, ApiError>;

    /// Stores a new item and assigns its key; returns it as stored.
    async fn add(&self, item: Author) -> Result<Author, ApiError>;

    /// Stores the new state of an existing item and returns it.
    async fn update(&self, item: Author) -> Result<Author, ApiError>;

    /// Removes an existing item.
    async fn delete(&self, key: Uuid) -> Result<(), ApiError>;
}

/// Keeps authors in memory: they are lost when the application stops. Use it to try the API.
#[derive(Default)]
pub struct InMemoryAuthorRepository {
    items: Mutex<BTreeMap<Uuid, Author>>,
}

impl InMemoryAuthorRepository {
    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<Uuid, Author>> {
        self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Whether an item is equal to every filter that has a value.
fn matches(_item: &Author, _filters: &AuthorFilters) -> bool {
    true
}

#[async_trait]
impl AuthorRepository for InMemoryAuthorRepository {
    async fn list(&self, query: &ListQuery<AuthorFilters>) -> Result<ListResult<Author>, ApiError> {
        let found: Vec<Author> = self.items().values().filter(|item| matches(item, &query.filters)).cloned().collect();
        let total = found.len() as u64;
        let window = found.into_iter().skip(query.offset as usize).take(query.limit.map_or(usize::MAX, |limit| limit as usize)).collect();
        Ok(ListResult { items: window, total })
    }

    async fn get(&self, key: Uuid) -> Result<Option<Author>, ApiError> {
        Ok(self.items().get(&key).cloned())
    }

    async fn add(&self, mut item: Author) -> Result<Author, ApiError> {
        item.id = Uuid::new_v4();
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn update(&self, item: Author) -> Result<Author, ApiError> {
        self.items().insert(item.id.clone(), item.clone());
        Ok(item)
    }

    async fn delete(&self, key: Uuid) -> Result<(), ApiError> {
        self.items().remove(&key);
        Ok(())
    }
}
