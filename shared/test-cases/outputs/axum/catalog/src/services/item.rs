//! Rules of items: what each operation checks and changes.

use std::sync::Arc;

use crate::common::body::Body;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::item::ItemCreate;
use crate::dtos::item::ItemUpdate;
use crate::models::item::Item;
use crate::repositories::category::CategoryRepository;
use crate::repositories::item::ItemFilters;
use crate::repositories::item::ItemRepository;

/// Rules of items.
pub struct ItemService {
    repository: Arc<dyn ItemRepository>,
    category_repository: Arc<dyn CategoryRepository>,
}

impl ItemService {
    pub fn new(repository: Arc<dyn ItemRepository>, category_repository: Arc<dyn CategoryRepository>) -> Self {
        Self { repository, category_repository }
    }

    async fn find(&self, key: i64) -> Result<Item, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("item"))
    }

    /// Every reference must point to a stored item.
    async fn check_references(&self, item: &Item) -> Result<(), ApiError> {
        if let Some(reference0) = &item.category_id
            && self.category_repository.get(reference0.clone()).await?.is_none()
        {
            return Err(ApiError::invalid("categoryId", "No Category has this key"));
        }
        Ok(())
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Item, body: &Body<ItemCreate>) {
        let data = &body.value;
        item.name = data.name.clone();
        item.price = data.price.clone();
        item.supplier_email = data.supplier_email.clone();
        item.category_id = data.category_id.clone();
        item.stock = data.stock.clone();
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Item, body: &Body<ItemUpdate>) {
        let data = &body.value;
        if body.has("name") {
            item.name = data.name.clone();
        }
        if body.has("price") {
            item.price = data.price.clone();
        }
        if body.has("supplierEmail") {
            item.supplier_email = data.supplier_email.clone();
        }
        if body.has("categoryId") {
            item.category_id = data.category_id.clone();
        }
        if body.has("stock") {
            item.stock = data.stock.clone();
        }
    }

    /// List items.
    pub async fn list_items(&self, query: ListQuery<ItemFilters>) -> Result<ListResult<Item>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get an item.
    pub async fn get_item(&self, key: i64) -> Result<Item, ApiError> {
        self.find(key).await
    }

    /// Create an item.
    pub async fn create_item(&self, body: Body<ItemCreate>) -> Result<Item, ApiError> {
        let mut item = Item::default();
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.add(item).await
    }

    /// Replace an item: every field the client may send takes the value of the body.
    pub async fn replace_item(&self, key: i64, body: Body<ItemCreate>) -> Result<Item, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.update(item).await
    }

    /// Update part of an item: only the fields in the body change.
    pub async fn update_item(&self, key: i64, body: Body<ItemUpdate>) -> Result<Item, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.update(item).await
    }

    /// Delete an item.
    pub async fn delete_item(&self, key: i64) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
