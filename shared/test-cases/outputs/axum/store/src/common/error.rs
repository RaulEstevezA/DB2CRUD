//! The error format of the API: {"error": {"code", "message", "details"}}, with the status of openapi.yaml.

use std::any::Any;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Where the request is wrong and why.
#[derive(Clone, Debug, Serialize)]
pub struct ErrorDetail {
    pub field: String,
    pub message: String,
}

/// An error the API answers with a status, a code and a message (see openapi.yaml).
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Vec<ErrorDetail>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), details: Vec::new() }
    }

    /// A request that breaks its rules, with each problem.
    pub fn invalid_body(details: Vec<ErrorDetail>) -> Self {
        Self { details, ..Self::new(StatusCode::BAD_REQUEST, "validation_error", "The request is not valid") }
    }

    pub fn invalid(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::invalid_body(vec![ErrorDetail { field: field.into(), message: message.into() }])
    }

    pub fn not_found(what: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", format!("No {what} has this key"))
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "Missing or invalid credentials")
    }

    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "The credentials do not allow this operation")
    }

    /// Code still to write: the API answers 501.
    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_IMPLEMENTED, "not_implemented", message)
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "Something went wrong on the server")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = serde_json::json!({ "code": self.code, "message": self.message });
        if !self.details.is_empty() {
            error["details"] = serde_json::to_value(&self.details).unwrap_or_default();
        }
        (self.status, Json(serde_json::json!({ "error": error }))).into_response()
    }
}

/// The status of a successful answer.
pub fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::OK)
}

/// Answers a request no route takes.
pub async fn no_route() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "No route matches this request")
}

/// Answers a method a path does not accept.
pub async fn wrong_method() -> ApiError {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "This path does not accept this method")
}

/// Answers a request whose handler panicked, after logging it.
pub fn panic_response(_panic: Box<dyn Any + Send + 'static>) -> Response {
    tracing::error!("Unexpected error: a handler panicked");
    ApiError::internal().into_response()
}
