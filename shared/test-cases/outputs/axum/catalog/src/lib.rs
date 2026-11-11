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
use crate::repositories::category::{InMemoryCategoryRepository, CategoryRepository};
use crate::repositories::item::{InMemoryItemRepository, ItemRepository};
use crate::services::category::CategoryService;
use crate::services::item::ItemService;

/// What every handler shares: the settings and the service of each resource.
#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub categories: Arc<CategoryService>,
    pub items: Arc<ItemService>,
}

/// Builds the API with its storage: the router that main serves and the tests call.
pub async fn build(settings: Settings) -> Result<Router, Box<dyn std::error::Error>> {
    let category_repository: Arc<dyn CategoryRepository> = Arc::new(InMemoryCategoryRepository::default());
    let item_repository: Arc<dyn ItemRepository> = Arc::new(InMemoryItemRepository::default());
    let state = AppState {
        settings: Arc::new(settings),
        categories: Arc::new(CategoryService::new(category_repository.clone())),
        items: Arc::new(ItemService::new(item_repository.clone(), category_repository.clone())),
    };
    Ok(Router::new()
        .merge(crate::routes::category::router())
        .merge(crate::routes::item::router())
        .fallback(no_route)
        .method_not_allowed_fallback(wrong_method)
        .layer(CatchPanicLayer::custom(panic_response))
        .with_state(state))
}
