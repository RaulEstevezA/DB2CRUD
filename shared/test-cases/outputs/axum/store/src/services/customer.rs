//! Rules of customers: what each operation checks and changes.

use std::sync::Arc;

use crate::common::body::Body;
use crate::common::clock;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::customer::CustomerCreate;
use crate::dtos::customer::CustomerUpdate;
use crate::models::customer::Customer;
use crate::repositories::customer::CustomerFilters;
use crate::repositories::customer::CustomerRepository;

/// Rules of customers.
pub struct CustomerService {
    repository: Arc<dyn CustomerRepository>,
}

impl CustomerService {
    pub fn new(repository: Arc<dyn CustomerRepository>) -> Self {
        Self { repository }
    }

    async fn find(&self, key: i64) -> Result<Customer, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("customer"))
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Customer, body: &Body<CustomerCreate>) {
        let data = &body.value;
        item.name = data.name.clone();
        item.email = data.email.clone();
        item.password = data.password.clone();
        item.phone = data.phone.clone();
        item.address = data.address.clone();
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Customer, body: &Body<CustomerUpdate>) {
        let data = &body.value;
        if body.has("name") {
            item.name = data.name.clone();
        }
        if body.has("email") {
            item.email = data.email.clone();
        }
        if body.has("password") {
            item.password = data.password.clone();
        }
        if body.has("phone") {
            item.phone = data.phone.clone();
        }
        if body.has("address") {
            item.address = data.address.clone();
        }
    }

    /// List customers.
    pub async fn list_customers(&self, query: ListQuery<CustomerFilters>) -> Result<ListResult<Customer>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get a customer.
    pub async fn get_customer(&self, key: i64) -> Result<Customer, ApiError> {
        self.find(key).await
    }

    /// Create a customer.
    pub async fn create_customer(&self, body: Body<CustomerCreate>) -> Result<Customer, ApiError> {
        let mut item = Customer::default();
        Self::apply(&mut item, &body);
        item.created_at = Some(clock::now());
        self.repository.add(item).await
    }

    /// Replace a customer: every field the client may send takes the value of the body.
    pub async fn replace_customer(&self, key: i64, body: Body<CustomerCreate>) -> Result<Customer, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.repository.update(item).await
    }

    /// Update part of a customer: only the fields in the body change.
    pub async fn update_customer(&self, key: i64, body: Body<CustomerUpdate>) -> Result<Customer, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.repository.update(item).await
    }

    /// Delete a customer.
    pub async fn delete_customer(&self, key: i64) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
