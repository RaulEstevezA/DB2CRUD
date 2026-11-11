"""Tests of the products endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import create_product, product_payload


def test_create_product(client: TestClient, headers: dict[str, str]) -> None:
    payload = product_payload(client, headers)
    response = client.post("/products", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["sku"] == payload["sku"]
    assert created["name"] == payload["name"]
    assert created["description"] == payload["description"]
    assert created["active"] == payload["active"]


def test_create_product_without_sku(client: TestClient, headers: dict[str, str]) -> None:
    payload = product_payload(client, headers)
    del payload["sku"]
    response = client.post("/products", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "sku" for detail in error["details"])


def test_get_product(client: TestClient, headers: dict[str, str]) -> None:
    created = create_product(client, headers)
    key = created["id"]
    response = client.get(f"/products/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_product(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/products/999999", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_products(client: TestClient, headers: dict[str, str]) -> None:
    create_product(client, headers)
    create_product(client, headers, variant=1)
    response = client.get("/products", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_products_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_product(client, headers)
    create_product(client, headers, variant=1)
    response = client.get("/products", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_products_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/products", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_product(client: TestClient, headers: dict[str, str]) -> None:
    created = create_product(client, headers)
    key = created["id"]
    payload = product_payload(client, headers, variant=1)
    response = client.put(f"/products/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["sku"] == payload["sku"]
    assert response.json()["name"] == payload["name"]
    assert response.json()["description"] == payload["description"]
    assert response.json()["active"] == payload["active"]


def test_update_product(client: TestClient, headers: dict[str, str]) -> None:
    created = create_product(client, headers)
    key = created["id"]
    response = client.patch(f"/products/{key}", json={"sku": "sku 2"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["sku"] == "sku 2"


def test_update_product_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_product(client, headers)
    key = created["id"]
    response = client.patch(f"/products/{key}", json={"sku": None}, headers=headers)
    assert response.status_code == 400


def test_delete_product(client: TestClient, headers: dict[str, str]) -> None:
    created = create_product(client, headers)
    key = created["id"]
    response = client.delete(f"/products/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/products/{key}", headers=headers).status_code == 404
