//! Routes of items: HTTP in, service calls, HTTP out.

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
use crate::dtos::item::ItemCreate;
use crate::dtos::item::ItemResponse;
use crate::dtos::item::ItemUpdate;
use crate::repositories::item::ItemFilters;

/// The routes of items.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/items", get(list_items).post(create_item))
        .route("/items/{id}", get(get_item).put(replace_item).patch(update_item).delete(delete_item))
}

/// List items.
async fn list_items(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = ItemFilters::default();
    let result = state.items.list_items(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(ItemResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get an item.
async fn get_item(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    Ok((status(200), Json(ItemResponse::from(state.items.get_item(key).await?))))
}

/// Create an item.
async fn create_item(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<ItemCreate>(&body, ItemCreate::rules)?;
    Ok((status(201), Json(ItemResponse::from(state.items.create_item(body).await?))))
}

/// Replace an item.
async fn replace_item(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<ItemCreate>(&body, ItemCreate::rules)?;
    Ok((status(200), Json(ItemResponse::from(state.items.replace_item(key, body).await?))))
}

/// Update part of an item.
async fn update_item(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<ItemUpdate>(&body, ItemUpdate::rules)?;
    Ok((status(200), Json(ItemResponse::from(state.items.update_item(key, body).await?))))
}

/// Delete an item.
async fn delete_item(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    state.items.delete_item(key).await?;
    Ok(status(204))
}
