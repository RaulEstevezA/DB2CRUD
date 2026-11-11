//! Routes of authors: HTTP in, service calls, HTTP out.

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
use crate::dtos::author::AuthorCreate;
use crate::dtos::author::AuthorResponse;
use crate::dtos::author::AuthorUpdate;
use crate::repositories::author::AuthorFilters;

/// The routes of authors.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/authors", get(list_authors).post(create_author))
        .route("/authors/{id}", get(get_author).put(replace_author).patch(update_author).delete(delete_author))
}

/// List authors.
async fn list_authors(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = AuthorFilters::default();
    let result = state.authors.list_authors(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(AuthorResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get an author.
async fn get_author(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    Ok((status(200), Json(AuthorResponse::from(state.authors.get_author(key).await?))))
}

/// Create an author.
async fn create_author(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<AuthorCreate>(&body, AuthorCreate::rules)?;
    Ok((status(201), Json(AuthorResponse::from(state.authors.create_author(body).await?))))
}

/// Replace an author.
async fn replace_author(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    let body = read_body::<AuthorCreate>(&body, AuthorCreate::rules)?;
    Ok((status(200), Json(AuthorResponse::from(state.authors.replace_author(key, body).await?))))
}

/// Update part of an author.
async fn update_author(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    let body = read_body::<AuthorUpdate>(&body, AuthorUpdate::rules)?;
    Ok((status(200), Json(AuthorResponse::from(state.authors.update_author(key, body).await?))))
}

/// Delete an author.
async fn delete_author(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = uuid_key(&params, "id")?;
    state.authors.delete_author(key).await?;
    Ok(status(204))
}
