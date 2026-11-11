//! Routes of categories: HTTP in, service calls, HTTP out.

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
use crate::common::query::long_key;
use crate::dtos::category::CategoryCreate;
use crate::dtos::category::CategoryResponse;
use crate::dtos::category::CategoryUpdate;
use crate::repositories::category::CategoryFilters;

/// The routes of categories.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/categories", get(list_categories).post(create_category))
        .route("/categories/{id}", get(get_category).put(replace_category).patch(update_category).delete(delete_category))
}

/// List categories.
async fn list_categories(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = CategoryFilters::default();
    let result = state.categories.list_categories(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(CategoryResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get a category.
async fn get_category(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    Ok((status(200), Json(CategoryResponse::from(state.categories.get_category(key).await?))))
}

/// Create a category.
async fn create_category(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<CategoryCreate>(&body, CategoryCreate::rules)?;
    Ok((status(201), Json(CategoryResponse::from(state.categories.create_category(body).await?))))
}

/// Replace a category.
async fn replace_category(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<CategoryCreate>(&body, CategoryCreate::rules)?;
    Ok((status(200), Json(CategoryResponse::from(state.categories.replace_category(key, body).await?))))
}

/// Update part of a category.
async fn update_category(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<CategoryUpdate>(&body, CategoryUpdate::rules)?;
    Ok((status(200), Json(CategoryResponse::from(state.categories.update_category(key, body).await?))))
}

/// Delete a category.
async fn delete_category(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    state.categories.delete_category(key).await?;
    Ok(status(204))
}
