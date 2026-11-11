//! Tests of the items endpoints.

use crate::support::{Api, headers, parse, text, without};

#[tokio::test]
async fn creates_an_item() {
    let api = Api::new().await;
    let payload = api.item_payload(0).await;

    let response = api.post("/items", &payload, &headers()).await;

    response.assert_status(201);
    assert!(response.json.get("id").is_some());
    assert_eq!(payload["name"], response.json["name"]);
    assert_eq!(payload["stock"], response.json["stock"]);
}

#[tokio::test]
async fn rejects_an_item_without_name() {
    let api = Api::new().await;
    let payload = without(api.item_payload(0).await, "name");

    let response = api.post("/items", &payload, &headers()).await;

    response.assert_status(400);
    assert_eq!(response.json["error"]["code"], "validation_error");
    let details = response.json["error"]["details"].as_array().cloned().unwrap_or_default();
    assert!(details.iter().any(|detail| detail["field"] == "name"));
}

#[tokio::test]
async fn gets_an_item() {
    let api = Api::new().await;
    let created = api.create_item(0).await;
    let key = text(&created["id"]);

    let response = api.get(&format!("/items/{key}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(created, response.json);
}

#[tokio::test]
async fn answers_404_for_a_missing_item() {
    let api = Api::new().await;
    let response = api.get("/items/999999", &headers()).await;

    response.assert_status(404);
    assert_eq!(response.json["error"]["code"], "not_found");
}

#[tokio::test]
async fn lists_items() {
    let api = Api::new().await;
    api.create_item(0).await;
    api.create_item(1).await;

    let response = api.get("/items", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["page"], 1);
}

#[tokio::test]
async fn lists_items_by_page() {
    let api = Api::new().await;
    api.create_item(0).await;
    api.create_item(1).await;

    let response = api.get("/items?page=2&size=1", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(response.json["page"], 2);
}

#[tokio::test]
async fn rejects_a_page_that_does_not_exist() {
    let api = Api::new().await;
    let response = api.get("/items?page=0", &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn replaces_an_item() {
    let api = Api::new().await;
    let created = api.create_item(0).await;
    let key = text(&created["id"]);
    let payload = api.item_payload(1).await;

    let response = api.put(&format!("/items/{key}"), &payload, &headers()).await;

    response.assert_status(200);
    assert_eq!(payload["name"], response.json["name"]);
    assert_eq!(payload["stock"], response.json["stock"]);
}

#[tokio::test]
async fn updates_part_of_an_item() {
    let api = Api::new().await;
    let created = api.create_item(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/items/{key}"), &parse("{\"name\":\"name 2\"}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(parse("\"name 2\""), response.json["name"]);
}

#[tokio::test]
async fn rejects_null_for_name() {
    let api = Api::new().await;
    let created = api.create_item(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/items/{key}"), &parse("{\"name\":null}"), &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn deletes_an_item() {
    let api = Api::new().await;
    let created = api.create_item(0).await;
    let key = text(&created["id"]);

    let response = api.delete(&format!("/items/{key}"), &headers()).await;

    response.assert_status(204);
    api.get(&format!("/items/{key}"), &headers()).await.assert_status(404);
}
