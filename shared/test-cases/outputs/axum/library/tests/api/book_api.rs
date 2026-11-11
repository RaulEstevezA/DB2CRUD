//! Tests of the books endpoints.

use crate::support::{Api, headers, parse, text, without};

#[tokio::test]
async fn creates_a_book() {
    let api = Api::new().await;
    let payload = api.book_payload(0).await;

    let response = api.post("/books", &payload, &headers()).await;

    response.assert_status(201);
    assert!(response.json.get("id").is_some());
    assert_eq!(payload["title"], response.json["title"]);
    assert_eq!(payload["isbn"], response.json["isbn"]);
    assert_eq!(payload["genre"], response.json["genre"]);
    assert_eq!(payload["pages"], response.json["pages"]);
    assert_eq!(payload["available"], response.json["available"]);
}

#[tokio::test]
async fn rejects_a_book_without_title() {
    let api = Api::new().await;
    let payload = without(api.book_payload(0).await, "title");

    let response = api.post("/books", &payload, &headers()).await;

    response.assert_status(400);
    assert_eq!(response.json["error"]["code"], "validation_error");
    let details = response.json["error"]["details"].as_array().cloned().unwrap_or_default();
    assert!(details.iter().any(|detail| detail["field"] == "title"));
}

#[tokio::test]
async fn gets_a_book() {
    let api = Api::new().await;
    let created = api.create_book(0).await;
    let key = text(&created["id"]);

    let response = api.get(&format!("/books/{key}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(created, response.json);
}

#[tokio::test]
async fn answers_404_for_a_missing_book() {
    let api = Api::new().await;
    let response = api.get("/books/00000000-0000-0000-0000-000000000000", &headers()).await;

    response.assert_status(404);
    assert_eq!(response.json["error"]["code"], "not_found");
}

#[tokio::test]
async fn lists_books() {
    let api = Api::new().await;
    api.create_book(0).await;
    api.create_book(1).await;

    let response = api.get("/books", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["page"], 1);
}

#[tokio::test]
async fn lists_books_by_page() {
    let api = Api::new().await;
    api.create_book(0).await;
    api.create_book(1).await;

    let response = api.get("/books?page=2&size=1", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(response.json["page"], 2);
}

#[tokio::test]
async fn rejects_a_page_that_does_not_exist() {
    let api = Api::new().await;
    let response = api.get("/books?page=0", &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn replaces_a_book() {
    let api = Api::new().await;
    let created = api.create_book(0).await;
    let key = text(&created["id"]);
    let payload = api.book_payload(1).await;

    let response = api.put(&format!("/books/{key}"), &payload, &headers()).await;

    response.assert_status(200);
    assert_eq!(payload["title"], response.json["title"]);
    assert_eq!(payload["isbn"], response.json["isbn"]);
    assert_eq!(payload["genre"], response.json["genre"]);
    assert_eq!(payload["pages"], response.json["pages"]);
    assert_eq!(payload["available"], response.json["available"]);
}

#[tokio::test]
async fn updates_part_of_a_book() {
    let api = Api::new().await;
    let created = api.create_book(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/books/{key}"), &parse("{\"title\":\"title 2\"}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(parse("\"title 2\""), response.json["title"]);
}

#[tokio::test]
async fn rejects_null_for_title() {
    let api = Api::new().await;
    let created = api.create_book(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/books/{key}"), &parse("{\"title\":null}"), &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn deletes_a_book() {
    let api = Api::new().await;
    let created = api.create_book(0).await;
    let key = text(&created["id"]);

    let response = api.delete(&format!("/books/{key}"), &headers()).await;

    response.assert_status(204);
    api.get(&format!("/books/{key}"), &headers()).await.assert_status(404);
}
