//! Tests of the products endpoints.

use crate::support::{Api, headers, parse, text, without};

#[tokio::test]
async fn creates_a_product() {
    let api = Api::new().await;
    let payload = api.product_payload(0).await;

    let response = api.post("/products", &payload, &headers()).await;

    response.assert_status(201);
    assert!(response.json.get("id").is_some());
    assert_eq!(payload["sku"], response.json["sku"]);
    assert_eq!(payload["name"], response.json["name"]);
    assert_eq!(payload["description"], response.json["description"]);
    assert_eq!(payload["active"], response.json["active"]);
}

#[tokio::test]
async fn rejects_a_product_without_sku() {
    let api = Api::new().await;
    let payload = without(api.product_payload(0).await, "sku");

    let response = api.post("/products", &payload, &headers()).await;

    response.assert_status(400);
    assert_eq!(response.json["error"]["code"], "validation_error");
    let details = response.json["error"]["details"].as_array().cloned().unwrap_or_default();
    assert!(details.iter().any(|detail| detail["field"] == "sku"));
}

#[tokio::test]
async fn gets_a_product() {
    let api = Api::new().await;
    let created = api.create_product(0).await;
    let key = text(&created["id"]);

    let response = api.get(&format!("/products/{key}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(created, response.json);
}

#[tokio::test]
async fn answers_404_for_a_missing_product() {
    let api = Api::new().await;
    let response = api.get("/products/999999", &headers()).await;

    response.assert_status(404);
    assert_eq!(response.json["error"]["code"], "not_found");
}

#[tokio::test]
async fn lists_products() {
    let api = Api::new().await;
    api.create_product(0).await;
    api.create_product(1).await;

    let response = api.get("/products", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["page"], 1);
}

#[tokio::test]
async fn lists_products_by_page() {
    let api = Api::new().await;
    api.create_product(0).await;
    api.create_product(1).await;

    let response = api.get("/products?page=2&size=1", &headers()).await;

    response.assert_status(200);
    assert_eq!(response.json["total"], 2);
    assert_eq!(response.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(response.json["page"], 2);
}

#[tokio::test]
async fn rejects_a_page_that_does_not_exist() {
    let api = Api::new().await;
    let response = api.get("/products?page=0", &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn replaces_a_product() {
    let api = Api::new().await;
    let created = api.create_product(0).await;
    let key = text(&created["id"]);
    let payload = api.product_payload(1).await;

    let response = api.put(&format!("/products/{key}"), &payload, &headers()).await;

    response.assert_status(200);
    assert_eq!(payload["sku"], response.json["sku"]);
    assert_eq!(payload["name"], response.json["name"]);
    assert_eq!(payload["description"], response.json["description"]);
    assert_eq!(payload["active"], response.json["active"]);
}

#[tokio::test]
async fn updates_part_of_a_product() {
    let api = Api::new().await;
    let created = api.create_product(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/products/{key}"), &parse("{\"sku\":\"sku 2\"}"), &headers()).await;

    response.assert_status(200);
    assert_eq!(parse("\"sku 2\""), response.json["sku"]);
}

#[tokio::test]
async fn rejects_null_for_sku() {
    let api = Api::new().await;
    let created = api.create_product(0).await;
    let key = text(&created["id"]);

    let response = api.patch(&format!("/products/{key}"), &parse("{\"sku\":null}"), &headers()).await;

    response.assert_status(400);
}

#[tokio::test]
async fn deletes_a_product() {
    let api = Api::new().await;
    let created = api.create_product(0).await;
    let key = text(&created["id"]);

    let response = api.delete(&format!("/products/{key}"), &headers()).await;

    response.assert_status(204);
    api.get(&format!("/products/{key}"), &headers()).await.assert_status(404);
}
