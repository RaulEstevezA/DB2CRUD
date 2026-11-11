//! Rules of products: what each operation checks and changes.

use std::sync::Arc;

use crate::common::body::Body;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::product::ProductCreate;
use crate::dtos::product::ProductUpdate;
use crate::models::product::Product;
use crate::repositories::product::ProductFilters;
use crate::repositories::product::ProductRepository;

/// Rules of products.
pub struct ProductService {
    repository: Arc<dyn ProductRepository>,
}

impl ProductService {
    pub fn new(repository: Arc<dyn ProductRepository>) -> Self {
        Self { repository }
    }

    async fn find(&self, key: i64) -> Result<Product, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("product"))
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Product, body: &Body<ProductCreate>) {
        let data = &body.value;
        item.sku = data.sku.clone();
        item.name = data.name.clone();
        item.description = data.description.clone();
        item.price = data.price.clone();
        item.stock = data.stock.clone();
        item.active = data.active.clone();
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Product, body: &Body<ProductUpdate>) {
        let data = &body.value;
        if body.has("sku") {
            item.sku = data.sku.clone();
        }
        if body.has("name") {
            item.name = data.name.clone();
        }
        if body.has("description") {
            item.description = data.description.clone();
        }
        if body.has("price") {
            item.price = data.price.clone();
        }
        if body.has("stock") {
            item.stock = data.stock.clone();
        }
        if body.has("active") {
            item.active = data.active.clone();
        }
    }

    /// List products.
    pub async fn list_products(&self, query: ListQuery<ProductFilters>) -> Result<ListResult<Product>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get a product.
    pub async fn get_product(&self, key: i64) -> Result<Product, ApiError> {
        self.find(key).await
    }

    /// Create a product.
    pub async fn create_product(&self, body: Body<ProductCreate>) -> Result<Product, ApiError> {
        let mut item = Product::default();
        Self::apply(&mut item, &body);
        self.repository.add(item).await
    }

    /// Replace a product: every field the client may send takes the value of the body.
    pub async fn replace_product(&self, key: i64, body: Body<ProductCreate>) -> Result<Product, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.repository.update(item).await
    }

    /// Update part of a product: only the fields in the body change.
    pub async fn update_product(&self, key: i64, body: Body<ProductUpdate>) -> Result<Product, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.repository.update(item).await
    }

    /// Delete a product.
    pub async fn delete_product(&self, key: i64) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
