//! The API: the state every handler shares, and the router with every route.

pub mod common;
pub mod dtos;
pub mod models;
pub mod repositories;
pub mod routes;
pub mod services;

use std::sync::Arc;

use axum::Router;
use tower_http::catch_panic::CatchPanicLayer;

use crate::common::error::{no_route, panic_response, wrong_method};
use crate::common::settings::Settings;
use crate::repositories::customer::{InMemoryCustomerRepository, CustomerRepository};
use crate::repositories::order::{InMemoryOrderRepository, OrderRepository};
use crate::repositories::product::{InMemoryProductRepository, ProductRepository};
use crate::services::customer::CustomerService;
use crate::services::order::OrderService;
use crate::services::product::ProductService;

/// What every handler shares: the settings and the service of each resource.
#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub customers: Arc<CustomerService>,
    pub products: Arc<ProductService>,
    pub orders: Arc<OrderService>,
}

/// Builds the API with its storage: the router that main serves and the tests call.
pub async fn build(settings: Settings) -> Result<Router, Box<dyn std::error::Error>> {
    let customer_repository: Arc<dyn CustomerRepository> = Arc::new(InMemoryCustomerRepository::default());
    let product_repository: Arc<dyn ProductRepository> = Arc::new(InMemoryProductRepository::default());
    let order_repository: Arc<dyn OrderRepository> = Arc::new(InMemoryOrderRepository::default());
    let state = AppState {
        settings: Arc::new(settings),
        customers: Arc::new(CustomerService::new(customer_repository.clone())),
        products: Arc::new(ProductService::new(product_repository.clone())),
        orders: Arc::new(OrderService::new(order_repository.clone(), customer_repository.clone(), product_repository.clone())),
    };
    Ok(Router::new()
        .merge(crate::routes::customer::router())
        .merge(crate::routes::product::router())
        .merge(crate::routes::order::router())
        .fallback(no_route)
        .method_not_allowed_fallback(wrong_method)
        .layer(CatchPanicLayer::custom(panic_response))
        .with_state(state))
}
