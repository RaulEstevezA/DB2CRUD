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
use crate::repositories::author::{InMemoryAuthorRepository, AuthorRepository};
use crate::repositories::book::{InMemoryBookRepository, BookRepository};
use crate::services::author::AuthorService;
use crate::services::book::BookService;

/// What every handler shares: the settings and the service of each resource.
#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub authors: Arc<AuthorService>,
    pub books: Arc<BookService>,
}

/// Builds the API with its storage: the router that main serves and the tests call.
pub async fn build(settings: Settings) -> Result<Router, Box<dyn std::error::Error>> {
    let author_repository: Arc<dyn AuthorRepository> = Arc::new(InMemoryAuthorRepository::default());
    let book_repository: Arc<dyn BookRepository> = Arc::new(InMemoryBookRepository::default());
    let state = AppState {
        settings: Arc::new(settings),
        authors: Arc::new(AuthorService::new(author_repository.clone())),
        books: Arc::new(BookService::new(book_repository.clone(), author_repository.clone())),
    };
    Ok(Router::new()
        .merge(crate::routes::author::router())
        .merge(crate::routes::book::router())
        .fallback(no_route)
        .method_not_allowed_fallback(wrong_method)
        .layer(CatchPanicLayer::custom(panic_response))
        .with_state(state))
}
