"""Tests of the customers endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import create_customer, customer_payload


def test_create_customer(client: TestClient, headers: dict[str, str]) -> None:
    payload = customer_payload(client, headers)
    response = client.post("/customers", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["name"] == payload["name"]
    assert created["email"] == payload["email"]
    assert created["phone"] == payload["phone"]


def test_create_customer_without_name(client: TestClient, headers: dict[str, str]) -> None:
    payload = customer_payload(client, headers)
    del payload["name"]
    response = client.post("/customers", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "name" for detail in error["details"])


def test_get_customer(client: TestClient, headers: dict[str, str]) -> None:
    created = create_customer(client, headers)
    key = created["id"]
    response = client.get(f"/customers/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_customer(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/customers/999999", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_customers(client: TestClient, headers: dict[str, str]) -> None:
    create_customer(client, headers)
    create_customer(client, headers, variant=1)
    response = client.get("/customers", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_customers_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_customer(client, headers)
    create_customer(client, headers, variant=1)
    response = client.get("/customers", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_customers_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/customers", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_customer(client: TestClient, headers: dict[str, str]) -> None:
    created = create_customer(client, headers)
    key = created["id"]
    payload = customer_payload(client, headers, variant=1)
    response = client.put(f"/customers/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == payload["name"]
    assert response.json()["email"] == payload["email"]
    assert response.json()["phone"] == payload["phone"]


def test_update_customer(client: TestClient, headers: dict[str, str]) -> None:
    created = create_customer(client, headers)
    key = created["id"]
    response = client.patch(f"/customers/{key}", json={"name": "name 2"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "name 2"


def test_update_customer_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_customer(client, headers)
    key = created["id"]
    response = client.patch(f"/customers/{key}", json={"name": None}, headers=headers)
    assert response.status_code == 400


def test_delete_customer(client: TestClient, headers: dict[str, str]) -> None:
    created = create_customer(client, headers)
    key = created["id"]
    response = client.delete(f"/customers/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/customers/{key}", headers=headers).status_code == 404
