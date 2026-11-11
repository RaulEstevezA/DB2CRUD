//! Routes of orders: HTTP in, service calls, HTTP out.

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
use crate::dtos::order::OrderCreate;
use crate::dtos::order::OrderResponse;
use crate::dtos::order::OrderUpdate;
use crate::repositories::order::OrderFilters;

/// The routes of orders.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/orders", get(list_orders).post(create_order))
        .route("/orders/{id}", get(get_order).put(replace_order).patch(update_order).delete(delete_order))
}

/// List orders.
async fn list_orders(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = OrderFilters::default();
    let result = state.orders.list_orders(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(OrderResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get an order.
async fn get_order(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    Ok((status(200), Json(OrderResponse::from(state.orders.get_order(key).await?))))
}

/// Create an order.
async fn create_order(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<OrderCreate>(&body, OrderCreate::rules)?;
    Ok((status(201), Json(OrderResponse::from(state.orders.create_order(body).await?))))
}

/// Replace an order.
async fn replace_order(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<OrderCreate>(&body, OrderCreate::rules)?;
    Ok((status(200), Json(OrderResponse::from(state.orders.replace_order(key, body).await?))))
}

/// Update part of an order.
async fn update_order(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<OrderUpdate>(&body, OrderUpdate::rules)?;
    Ok((status(200), Json(OrderResponse::from(state.orders.update_order(key, body).await?))))
}

/// Delete an order.
async fn delete_order(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    state.orders.delete_order(key).await?;
    Ok(status(204))
}
