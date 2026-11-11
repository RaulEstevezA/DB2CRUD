"""Tests of the items endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import create_item, item_payload


def test_create_item(client: TestClient, headers: dict[str, str]) -> None:
    payload = item_payload(client, headers)
    response = client.post("/items", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["name"] == payload["name"]
    assert created["stock"] == payload["stock"]


def test_create_item_without_name(client: TestClient, headers: dict[str, str]) -> None:
    payload = item_payload(client, headers)
    del payload["name"]
    response = client.post("/items", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "name" for detail in error["details"])


def test_get_item(client: TestClient, headers: dict[str, str]) -> None:
    created = create_item(client, headers)
    key = created["id"]
    response = client.get(f"/items/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_item(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/items/999999", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_items(client: TestClient, headers: dict[str, str]) -> None:
    create_item(client, headers)
    create_item(client, headers, variant=1)
    response = client.get("/items", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_items_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_item(client, headers)
    create_item(client, headers, variant=1)
    response = client.get("/items", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_items_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/items", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_item(client: TestClient, headers: dict[str, str]) -> None:
    created = create_item(client, headers)
    key = created["id"]
    payload = item_payload(client, headers, variant=1)
    response = client.put(f"/items/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == payload["name"]
    assert response.json()["stock"] == payload["stock"]


def test_update_item(client: TestClient, headers: dict[str, str]) -> None:
    created = create_item(client, headers)
    key = created["id"]
    response = client.patch(f"/items/{key}", json={"name": "name 2"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "name 2"


def test_update_item_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_item(client, headers)
    key = created["id"]
    response = client.patch(f"/items/{key}", json={"name": None}, headers=headers)
    assert response.status_code == 400


def test_delete_item(client: TestClient, headers: dict[str, str]) -> None:
    created = create_item(client, headers)
    key = created["id"]
    response = client.delete(f"/items/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/items/{key}", headers=headers).status_code == 404
