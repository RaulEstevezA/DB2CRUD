//! Tests of the orders endpoints.

use crate::support::{Api, headers, parse, text, without};

#[tokio::test]
async fn creates_an_order() {
    let api = Api::new().await;
    let payload = api.order_payload(0).await;

    let response = api.post("/orders", &payload, &headers()).await;

    response.assert_status(201);
    assert!(response.json.get("id").is_some());
    assert_eq!(payload["status"], response.json["status"]);
    assert_eq!(payload["notes"], response.json["notes"]);
}

#[tokio::test]
async fn rejects_an_order_without_lines() {
    let api = Api::new().await;
    let payload = without(api.order_payload(0).await, "lines");

    let response = api.post("/orders", &payload, &headers()).await;

    response.assert_status(400);
    assert_eq!(response.json["error"]["code"], "validation_error");
    let details = response.json["error"]["details"].as_array().cloned().unwrap_or_default();
    assert!(details.iter().any(|detail| detail["field"] == "lines"));
}

#[tokio::test]
async fn gets_an_order() {
    let api = Api::new().await;
    let created = api.create_order(0).await;
    let key = text(&created["id"]);

    let response = api.get(&format!("/orders/{key}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(created, response.json);
}

#[tokio::test]
async fn answers_404_for_a_missing_order() {
    let api = Api::new().await;
    let response = api.get("/orders/999999", &headers()).await;

    response.assert_status(404);
    assert_eq!(response.json["error"]["code"], "not_found");
}

#[tokio::test]
async fn lists_orders() {
    let api = Api::new().await;
    api.create_order(0).await;
    api.create_order(1).await;

    let response = api.get("/orders", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["page"], 1);
}

#[tokio::test]
async fn lists_orders_by_page() {
    let api = Api::new().await;
    api.create_order(0).await;
    api.create_order(1).await;

    let response = api.get("/orders?page=2&size=1", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(response.json["page"], 2);
}

#[tokio::test]
async fn rejects_a_page_that_does_not_exist() {
    let api = Api::new().await;
    let response = api.get("/orders?page=0", &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn replaces_an_order() {
    let api = Api::new().await;
    let created = api.create_order(0).await;
    let key = text(&created["id"]);
    let payload = api.order_payload(1).await;

    let response = api.put(&format!("/orders/{key}"), &payload, &headers()).await;

    response.assert_status(200);
    assert_eq!(payload["status"], response.json["status"]);
    assert_eq!(payload["notes"], response.json["notes"]);
}

#[tokio::test]
async fn updates_part_of_an_order() {
    let api = Api::new().await;
    let created = api.create_order(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/orders/{key}"), &parse("{\"total\":2}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(Some(2.0), response.json["total"].as_f64());
}

#[tokio::test]
async fn rejects_null_for_total() {
    let api = Api::new().await;
    let created = api.create_order(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/orders/{key}"), &parse("{\"total\":null}"), &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn deletes_an_order() {
    let api = Api::new().await;
    let created = api.create_order(0).await;
    let key = text(&created["id"]);

    let response = api.delete(&format!("/orders/{key}"), &headers()).await;

    response.assert_status(204);
    api.get(&format!("/orders/{key}"), &headers()).await.assert_status(404);
}
