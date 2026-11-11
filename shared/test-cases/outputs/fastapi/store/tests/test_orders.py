"""Tests of the orders endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import create_order, order_payload


def test_create_order(client: TestClient, headers: dict[str, str]) -> None:
    payload = order_payload(client, headers)
    response = client.post("/orders", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["status"] == payload["status"]
    assert created["notes"] == payload["notes"]


def test_create_order_without_lines(client: TestClient, headers: dict[str, str]) -> None:
    payload = order_payload(client, headers)
    del payload["lines"]
    response = client.post("/orders", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "lines" for detail in error["details"])


def test_get_order(client: TestClient, headers: dict[str, str]) -> None:
    created = create_order(client, headers)
    key = created["id"]
    response = client.get(f"/orders/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_order(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/orders/999999", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_orders(client: TestClient, headers: dict[str, str]) -> None:
    create_order(client, headers)
    create_order(client, headers, variant=1)
    response = client.get("/orders", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_orders_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_order(client, headers)
    create_order(client, headers, variant=1)
    response = client.get("/orders", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_orders_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/orders", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_order(client: TestClient, headers: dict[str, str]) -> None:
    created = create_order(client, headers)
    key = created["id"]
    payload = order_payload(client, headers, variant=1)
    response = client.put(f"/orders/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == payload["status"]
    assert response.json()["notes"] == payload["notes"]


def test_update_order(client: TestClient, headers: dict[str, str]) -> None:
    created = create_order(client, headers)
    key = created["id"]
    response = client.patch(f"/orders/{key}", json={"total": 2}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["total"] == 2


def test_update_order_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_order(client, headers)
    key = created["id"]
    response = client.patch(f"/orders/{key}", json={"total": None}, headers=headers)
    assert response.status_code == 400


def test_delete_order(client: TestClient, headers: dict[str, str]) -> None:
    created = create_order(client, headers)
    key = created["id"]
    response = client.delete(f"/orders/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/orders/{key}", headers=headers).status_code == 404
