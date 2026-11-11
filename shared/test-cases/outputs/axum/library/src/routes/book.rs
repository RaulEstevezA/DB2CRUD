//! Routes of books: HTTP in, service calls, HTTP out.

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;

use crate::AppState;
use crate::common::body::read_body;
use crate::common::error::{ApiError, status};
use crate::common::list::ListQuery;
use crate::common::list::PageResponse;
use crate::common::query::Params;
use crate::common::query::int_query;
use crate::common::query::uuid_key;
use crate::dtos::book::BookCreate;
use crate::dtos::book::BookResponse;
use crate::dtos::book::BookUpdate;
use crate::repositories::book::BookFilters;

/// The routes of books.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/books", get(list_books).post(create_book))
        .route("/books/{id}", get(get_book).put(replace_book).patch(update_book).delete(delete_book))
}

/// List books.
async fn list_books(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = BookFilters::default();
    let result = state.books.list_books(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(BookResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get a book.
async fn get_book(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    Ok((status(200), Json(BookResponse::from(state.books.get_book(key).await?))))
}

/// Create a book.
async fn create_book(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<BookCreate>(&body, BookCreate::rules)?;
    Ok((status(201), Json(BookResponse::from(state.books.create_book(body).await?))))
}

/// Replace a book.
async fn replace_book(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    let body = read_body::<BookCreate>(&body, BookCreate::rules)?;
    Ok((status(200), Json(BookResponse::from(state.books.replace_book(key, body).await?))))
}

/// Update part of a book.
async fn update_book(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    let body = read_body::<BookUpdate>(&body, BookUpdate::rules)?;
    Ok((status(200), Json(BookResponse::from(state.books.update_book(key, body).await?))))
}

/// Delete a book.
async fn delete_book(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    state.books.delete_book(key).await?;
    Ok(status(204))
}
