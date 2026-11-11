//! Base of the tests: a new application for each test, so each one starts with empty storage.

// Each test module uses only some of these helpers
#![allow(dead_code)]

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use library_api::build;
use library_api::common::settings::Settings;
use serde_json::Value;
use tower::ServiceExt;

/// Settings of the application under test.
fn settings() -> Settings {
    Settings::default()
}

/// Headers of a client allowed to call every endpoint.
pub fn headers() -> Vec<(&'static str, String)> {
    Vec::new()
}

/// The application under test, called through its router.
pub struct Api {
    router: Router,
}

/// The answer of a request in a test: its status and its JSON body (null when it has none).
pub struct TestResponse {
    pub status: u16,
    pub text: String,
    pub json: Value,
}

impl TestResponse {
    pub fn assert_status(&self, expected: u16) {
        assert_eq!(expected, self.status, "{}", self.text);
    }
}

impl Api {
    pub async fn new() -> Self {
        let router = build(settings()).await.expect("the API starts");
        Self { router }
    }

    pub async fn get(&self, path: &str, headers: &[(&'static str, String)]) -> TestResponse {
        self.send("GET", path, None, headers).await
    }

    pub async fn post(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {
        self.send("POST", path, Some(body), headers).await
    }

    pub async fn put(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {
        self.send("PUT", path, Some(body), headers).await
    }

    pub async fn patch(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {
        self.send("PATCH", path, Some(body), headers).await
    }

    pub async fn delete(&self, path: &str, headers: &[(&'static str, String)]) -> TestResponse {
        self.send("DELETE", path, None, headers).await
    }

    /// Sends a request, with a JSON body when there is one.
    pub async fn send(&self, method: &str, path: &str, body: Option<&Value>, headers: &[(&'static str, String)]) -> TestResponse {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let request = match body {
            Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .expect("the request is valid");
        let response = self.router.clone().oneshot(request).await.expect("the router answers");
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("the body can be read");
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let json = serde_json::from_str(&text).unwrap_or(Value::Null);
        TestResponse { status, text, json }
    }

    /// A valid body to create an author, with the items it refers to created first.
    pub async fn author_payload(&self, variant: usize) -> Value {
        let body = if variant == 0 { parse("{\"name\":\"name 1\",\"email\":\"user1@example.com\",\"born\":\"2024-01-15\"}") } else { parse("{\"name\":\"name 2\",\"email\":\"user2@example.com\",\"born\":\"2024-01-16\"}") };
        body
    }

    /// Creates an author and returns it as the API answers.
    pub async fn create_author(&self, variant: usize) -> Value {
        let payload = self.author_payload(variant).await;
        let response = self.post("/authors", &payload, &headers()).await;
        response.assert_status(201);
        response.json
    }

    /// A valid body to create a book, with the items it refers to created first.
    pub async fn book_payload(&self, variant: usize) -> Value {
        let mut body = if variant == 0 { parse("{\"title\":\"title 1\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"novel\",\"pages\":1,\"published\":\"2024-01-15\",\"available\":true}") } else { parse("{\"title\":\"title 2\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"essay\",\"pages\":2,\"published\":\"2024-01-16\",\"available\":false}") };
        body = with(body, "/authorId", self.create_author(0).await["id"].clone());
        body
    }

    /// Creates a book and returns it as the API answers.
    pub async fn create_book(&self, variant: usize) -> Value {
        let payload = self.book_payload(variant).await;
        let response = self.post("/books", &payload, &headers()).await;
        response.assert_status(201);
        response.json
    }
}

/// A JSON value from its text.
pub fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("the JSON of the test is valid")
}

/// The text of a key in a JSON answer, for a path.
pub fn text(value: &Value) -> String {
    value.as_str().map(String::from).unwrap_or_else(|| value.to_string())
}

/// A copy of a JSON value with another value at a JSON pointer: "/lines/0/productId".
pub fn with(mut value: Value, pointer: &str, new: Value) -> Value {
    let (parent, last) = pointer.rsplit_once('/').expect("the pointer starts with /");
    let last = last.replace("~1", "/").replace("~0", "~");
    match value.pointer_mut(parent) {
        Some(Value::Object(map)) => {
            map.insert(last, new);
        }
        Some(Value::Array(items)) => {
            if let Some(item) = last.parse::<usize>().ok().and_then(|index| items.get_mut(index)) {
                *item = new;
            }
        }
        _ => {}
    }
    value
}

/// A copy of a JSON object without a field.
pub fn without(mut value: Value, field: &str) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.remove(field);
    }
    value
}
