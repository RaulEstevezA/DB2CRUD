//! Rules of categories: what each operation checks and changes.

use std::sync::Arc;

use crate::common::body::Body;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::category::CategoryCreate;
use crate::dtos::category::CategoryUpdate;
use crate::models::category::Category;
use crate::repositories::category::CategoryFilters;
use crate::repositories::category::CategoryRepository;

/// Rules of categories.
pub struct CategoryService {
    repository: Arc<dyn CategoryRepository>,
}

impl CategoryService {
    pub fn new(repository: Arc<dyn CategoryRepository>) -> Self {
        Self { repository }
    }

    async fn find(&self, key: i64) -> Result<Category, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("category"))
    }

    /// Every reference must point to a stored item.
    async fn check_references(&self, item: &Category) -> Result<(), ApiError> {
        if let Some(reference0) = &item.parent_id
            && self.repository.get(reference0.clone()).await?.is_none()
        {
            return Err(ApiError::invalid("parentId", "No Category has this key"));
        }
        Ok(())
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Category, body: &Body<CategoryCreate>) {
        let data = &body.value;
        item.name = data.name.clone();
        item.parent_id = data.parent_id.clone();
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Category, body: &Body<CategoryUpdate>) {
        let data = &body.value;
        if body.has("name") {
            item.name = data.name.clone();
        }
        if body.has("parentId") {
            item.parent_id = data.parent_id.clone();
        }
    }

    /// List categories.
    pub async fn list_categories(&self, query: ListQuery<CategoryFilters>) -> Result<ListResult<Category>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get a category.
    pub async fn get_category(&self, key: i64) -> Result<Category, ApiError> {
        self.find(key).await
    }

    /// Create a category.
    pub async fn create_category(&self, body: Body<CategoryCreate>) -> Result<Category, ApiError> {
        let mut item = Category::default();
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.add(item).await
    }

    /// Replace a category: every field the client may send takes the value of the body.
    pub async fn replace_category(&self, key: i64, body: Body<CategoryCreate>) -> Result<Category, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.update(item).await
    }

    /// Update part of a category: only the fields in the body change.
    pub async fn update_category(&self, key: i64, body: Body<CategoryUpdate>) -> Result<Category, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.update(item).await
    }

    /// Delete a category.
    pub async fn delete_category(&self, key: i64) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
