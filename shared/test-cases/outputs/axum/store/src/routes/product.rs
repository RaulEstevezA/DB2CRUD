//! Routes of products: HTTP in, service calls, HTTP out.

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
use crate::dtos::product::ProductCreate;
use crate::dtos::product::ProductResponse;
use crate::dtos::product::ProductUpdate;
use crate::repositories::product::ProductFilters;

/// The routes of products.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/products", get(list_products).post(create_product))
        .route("/products/{id}", get(get_product).put(replace_product).patch(update_product).delete(delete_product))
}

/// List products.
async fn list_products(State(state): State<AppState>, Query(query): Query<Params>) -> Result<impl IntoResponse, ApiError> {
    let page = int_query(&query, "page", 1, 1, None)?;
    let size = int_query(&query, "size", 20, 1, Some(100))?;
    let filters = ProductFilters::default();
    let result = state.products.list_products(ListQuery::new(filters, None, (page - 1) * size, Some(size))).await?;
    let items = result.items.into_iter().map(ProductResponse::from).collect();
    Ok((status(200), Json(PageResponse { items, total: result.total, page, size })))
}

/// Get a product.
async fn get_product(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    Ok((status(200), Json(ProductResponse::from(state.products.get_product(key).await?))))
}

/// Create a product.
async fn create_product(State(state): State<AppState>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let body = read_body::<ProductCreate>(&body, ProductCreate::rules)?;
    Ok((status(201), Json(ProductResponse::from(state.products.create_product(body).await?))))
}

/// Replace a product.
async fn replace_product(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<ProductCreate>(&body, ProductCreate::rules)?;
    Ok((status(200), Json(ProductResponse::from(state.products.replace_product(key, body).await?))))
}

/// Update part of a product.
async fn update_product(State(state): State<AppState>, Path(params): Path<Params>, body: Bytes) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    let body = read_body::<ProductUpdate>(&body, ProductUpdate::rules)?;
    Ok((status(200), Json(ProductResponse::from(state.products.update_product(key, body).await?))))
}

/// Delete a product.
async fn delete_product(State(state): State<AppState>, Path(params): Path<Params>) -> Result<impl IntoResponse, ApiError> {
    let key = long_key(&params, "id")?;
    state.products.delete_product(key).await?;
    Ok(status(204))
}
