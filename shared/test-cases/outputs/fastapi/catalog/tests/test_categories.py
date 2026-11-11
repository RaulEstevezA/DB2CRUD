"""Tests of the categories endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import category_payload, create_category


def test_create_category(client: TestClient, headers: dict[str, str]) -> None:
    payload = category_payload(client, headers)
    response = client.post("/categories", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["name"] == payload["name"]


def test_create_category_without_name(client: TestClient, headers: dict[str, str]) -> None:
    payload = category_payload(client, headers)
    del payload["name"]
    response = client.post("/categories", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "name" for detail in error["details"])


def test_get_category(client: TestClient, headers: dict[str, str]) -> None:
    created = create_category(client, headers)
    key = created["id"]
    response = client.get(f"/categories/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_category(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/categories/999999", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_categories(client: TestClient, headers: dict[str, str]) -> None:
    create_category(client, headers)
    create_category(client, headers, variant=1)
    response = client.get("/categories", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_categories_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_category(client, headers)
    create_category(client, headers, variant=1)
    response = client.get("/categories", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_categories_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/categories", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_category(client: TestClient, headers: dict[str, str]) -> None:
    created = create_category(client, headers)
    key = created["id"]
    payload = category_payload(client, headers, variant=1)
    response = client.put(f"/categories/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == payload["name"]


def test_update_category(client: TestClient, headers: dict[str, str]) -> None:
    created = create_category(client, headers)
    key = created["id"]
    response = client.patch(f"/categories/{key}", json={"name": "name 2"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "name 2"


def test_update_category_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_category(client, headers)
    key = created["id"]
    response = client.patch(f"/categories/{key}", json={"name": None}, headers=headers)
    assert response.status_code == 400


def test_delete_category(client: TestClient, headers: dict[str, str]) -> None:
    created = create_category(client, headers)
    key = created["id"]
    response = client.delete(f"/categories/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/categories/{key}", headers=headers).status_code == 404
