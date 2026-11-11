//! Rules of orders: what each operation checks and changes.

use std::sync::Arc;

use crate::common::body::Body;
use crate::common::clock;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::order::OrderCreate;
use crate::dtos::order::OrderUpdate;
use crate::models::order::Order;
use crate::repositories::customer::CustomerRepository;
use crate::repositories::order::OrderFilters;
use crate::repositories::order::OrderRepository;
use crate::repositories::product::ProductRepository;

/// Rules of orders.
pub struct OrderService {
    repository: Arc<dyn OrderRepository>,
    customer_repository: Arc<dyn CustomerRepository>,
    product_repository: Arc<dyn ProductRepository>,
}

impl OrderService {
    pub fn new(repository: Arc<dyn OrderRepository>, customer_repository: Arc<dyn CustomerRepository>, product_repository: Arc<dyn ProductRepository>) -> Self {
        Self { repository, customer_repository, product_repository }
    }

    async fn find(&self, key: i64) -> Result<Order, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("order"))
    }

    /// Every reference must point to a stored item.
    async fn check_references(&self, item: &Order) -> Result<(), ApiError> {
        if let Some(reference0) = &item.customer_id
            && self.customer_repository.get(reference0.clone()).await?.is_none()
        {
            return Err(ApiError::invalid("customerId", "No Customer has this key"));
        }
        for item0 in item.lines.iter().flatten() {
            if let Some(reference1) = &item0.product_id
                && self.product_repository.get(reference1.clone()).await?.is_none()
            {
                return Err(ApiError::invalid("lines.productId", "No Product has this key"));
            }
        }
        Ok(())
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Order, body: &Body<OrderCreate>) {
        let data = &body.value;
        item.customer_id = data.customer_id.clone();
        item.lines = data.lines.clone();
        item.status = data.status.clone();
        item.total = data.total.clone();
        item.notes = data.notes.clone();
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Order, body: &Body<OrderUpdate>) {
        let data = &body.value;
        if body.has("customerId") {
            item.customer_id = data.customer_id.clone();
        }
        if body.has("lines") {
            item.lines = data.lines.clone();
        }
        if body.has("status") {
            item.status = data.status.clone();
        }
        if body.has("total") {
            item.total = data.total.clone();
        }
        if body.has("notes") {
            item.notes = data.notes.clone();
        }
    }

    /// List orders.
    pub async fn list_orders(&self, query: ListQuery<OrderFilters>) -> Result<ListResult<Order>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get an order.
    pub async fn get_order(&self, key: i64) -> Result<Order, ApiError> {
        self.find(key).await
    }

    /// Create an order.
    pub async fn create_order(&self, body: Body<OrderCreate>) -> Result<Order, ApiError> {
        let mut item = Order::default();
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        item.created_at = Some(clock::now());
        item.updated_at = Some(clock::now());
        self.repository.add(item).await
    }

    /// Replace an order: every field the client may send takes the value of the body.
    pub async fn replace_order(&self, key: i64, body: Body<OrderCreate>) -> Result<Order, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        item.updated_at = Some(clock::now());
        self.repository.update(item).await
    }

    /// Update part of an order: only the fields in the body change.
    pub async fn update_order(&self, key: i64, body: Body<OrderUpdate>) -> Result<Order, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.check_references(&item).await?;
        item.updated_at = Some(clock::now());
        self.repository.update(item).await
    }

    /// Delete an order.
    pub async fn delete_order(&self, key: i64) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
