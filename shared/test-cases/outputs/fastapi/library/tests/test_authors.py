"""Tests of the authors endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import author_payload, create_author


def test_create_author(client: TestClient, headers: dict[str, str]) -> None:
    payload = author_payload(client, headers)
    response = client.post("/authors", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["name"] == payload["name"]


def test_create_author_without_name(client: TestClient, headers: dict[str, str]) -> None:
    payload = author_payload(client, headers)
    del payload["name"]
    response = client.post("/authors", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "name" for detail in error["details"])


def test_get_author(client: TestClient, headers: dict[str, str]) -> None:
    created = create_author(client, headers)
    key = created["id"]
    response = client.get(f"/authors/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_author(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/authors/00000000-0000-0000-0000-000000000000", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_authors(client: TestClient, headers: dict[str, str]) -> None:
    create_author(client, headers)
    create_author(client, headers, variant=1)
    response = client.get("/authors", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_authors_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_author(client, headers)
    create_author(client, headers, variant=1)
    response = client.get("/authors", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_authors_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/authors", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_author(client: TestClient, headers: dict[str, str]) -> None:
    created = create_author(client, headers)
    key = created["id"]
    payload = author_payload(client, headers, variant=1)
    response = client.put(f"/authors/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == payload["name"]


def test_update_author(client: TestClient, headers: dict[str, str]) -> None:
    created = create_author(client, headers)
    key = created["id"]
    response = client.patch(f"/authors/{key}", json={"name": "name 2"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "name 2"


def test_update_author_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_author(client, headers)
    key = created["id"]
    response = client.patch(f"/authors/{key}", json={"name": None}, headers=headers)
    assert response.status_code == 400


def test_delete_author(client: TestClient, headers: dict[str, str]) -> None:
    created = create_author(client, headers)
    key = created["id"]
    response = client.delete(f"/authors/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/authors/{key}", headers=headers).status_code == 404
