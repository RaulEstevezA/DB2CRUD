//! Routes of customers: HTTP in, service calls, HTTP out.

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
use crate::dtos::customer::CustomerCreate;
use crate::dtos::customer::CustomerResponse;
use crate::dtos::customer::CustomerUpdate;
use crate::repositories::customer::CustomerFilters;

/// The routes of customers.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/customers", get(list_customers).post(create_customer))
        .route("/customers/{id}", get(get_customer).put(replace_customer).patch(update_customer).delete(delete_customer))
}

/// List customers.
async fn list_customers(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = CustomerFilters::default();
    let result = state.customers.list_customers(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(CustomerResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get a customer.
async fn get_customer(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    Ok((status(200), Json(CustomerResponse::from(state.customers.get_customer(key).await?))))
}

/// Create a customer.
async fn create_customer(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<CustomerCreate>(&body, CustomerCreate::rules)?;
    Ok((status(201), Json(CustomerResponse::from(state.customers.create_customer(body).await?))))
}

/// Replace a customer.
async fn replace_customer(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<CustomerCreate>(&body, CustomerCreate::rules)?;
    Ok((status(200), Json(CustomerResponse::from(state.customers.replace_customer(key, body).await?))))
}

/// Update part of a customer.
async fn update_customer(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<CustomerUpdate>(&body, CustomerUpdate::rules)?;
    Ok((status(200), Json(CustomerResponse::from(state.customers.update_customer(key, body).await?))))
}

/// Delete a customer.
async fn delete_customer(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    state.customers.delete_customer(key).await?;
    Ok(status(204))
}
