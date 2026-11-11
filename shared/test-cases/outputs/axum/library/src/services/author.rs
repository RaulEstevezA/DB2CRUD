//! Rules of authors: what each operation checks and changes.

use std::sync::Arc;

use uuid::Uuid;

use crate::common::body::Body;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::author::AuthorCreate;
use crate::dtos::author::AuthorUpdate;
use crate::models::author::Author;
use crate::repositories::author::AuthorFilters;
use crate::repositories::author::AuthorRepository;

/// Rules of authors.
pub struct AuthorService {
    repository: Arc<dyn AuthorRepository>,
}

impl AuthorService {
    pub fn new(repository: Arc<dyn AuthorRepository>) -> Self {
        Self { repository }
    }

    async fn find(&self, key: Uuid) -> Result<Author, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("author"))
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Author, body: &Body<AuthorCreate>) {
        let data = &body.value;
        item.name = data.name.clone();
        item.email = if body.has("email") { data.email.clone() } else { None };
        item.born = if body.has("born") { data.born.clone() } else { None };
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Author, body: &Body<AuthorUpdate>) {
        let data = &body.value;
        if body.has("name") {
            item.name = data.name.clone();
        }
        if body.has("email") {
            item.email = data.email.clone();
        }
        if body.has("born") {
            item.born = data.born.clone();
        }
    }

    /// List authors.
    pub async fn list_authors(&self, query: ListQuery<AuthorFilters>) -> Result<ListResult<Author>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get an author.
    pub async fn get_author(&self, key: Uuid) -> Result<Author, ApiError> {
        self.find(key).await
    }

    /// Create an author.
    pub async fn create_author(&self, body: Body<AuthorCreate>) -> Result<Author, ApiError> {
        let mut item = Author::default();
        Self::apply(&mut item, &body);
        self.repository.add(item).await
    }

    /// Replace an author: every field the client may send takes the value of the body.
    pub async fn replace_author(&self, key: Uuid, body: Body<AuthorCreate>) -> Result<Author, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.repository.update(item).await
    }

    /// Update part of an author: only the fields in the body change.
    pub async fn update_author(&self, key: Uuid, body: Body<AuthorUpdate>) -> Result<Author, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.repository.update(item).await
    }

    /// Delete an author.
    pub async fn delete_author(&self, key: Uuid) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
