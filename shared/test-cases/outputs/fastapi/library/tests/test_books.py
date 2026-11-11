"""Tests of the books endpoints."""

from fastapi.testclient import TestClient

from tests.helpers import book_payload, create_book


def test_create_book(client: TestClient, headers: dict[str, str]) -> None:
    payload = book_payload(client, headers)
    response = client.post("/books", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["id"] is not None
    assert created["title"] == payload["title"]
    assert created["isbn"] == payload["isbn"]
    assert created["genre"] == payload["genre"]
    assert created["pages"] == payload["pages"]
    assert created["available"] == payload["available"]


def test_create_book_without_title(client: TestClient, headers: dict[str, str]) -> None:
    payload = book_payload(client, headers)
    del payload["title"]
    response = client.post("/books", json=payload, headers=headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(detail["field"] == "title" for detail in error["details"])


def test_get_book(client: TestClient, headers: dict[str, str]) -> None:
    created = create_book(client, headers)
    key = created["id"]
    response = client.get(f"/books/{key}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == created


def test_get_missing_book(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/books/00000000-0000-0000-0000-000000000000", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_list_books(client: TestClient, headers: dict[str, str]) -> None:
    create_book(client, headers)
    create_book(client, headers, variant=1)
    response = client.get("/books", headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert page["page"] == 1


def test_list_books_by_page(client: TestClient, headers: dict[str, str]) -> None:
    create_book(client, headers)
    create_book(client, headers, variant=1)
    response = client.get("/books", params={"page": 2, "size": 1}, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


def test_list_books_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/books", params={"page": 0}, headers=headers)
    assert response.status_code == 400


def test_replace_book(client: TestClient, headers: dict[str, str]) -> None:
    created = create_book(client, headers)
    key = created["id"]
    payload = book_payload(client, headers, variant=1)
    response = client.put(f"/books/{key}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["title"] == payload["title"]
    assert response.json()["isbn"] == payload["isbn"]
    assert response.json()["genre"] == payload["genre"]
    assert response.json()["pages"] == payload["pages"]
    assert response.json()["available"] == payload["available"]


def test_update_book(client: TestClient, headers: dict[str, str]) -> None:
    created = create_book(client, headers)
    key = created["id"]
    response = client.patch(f"/books/{key}", json={"title": "title 2"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "title 2"


def test_update_book_rejects_null(client: TestClient, headers: dict[str, str]) -> None:
    created = create_book(client, headers)
    key = created["id"]
    response = client.patch(f"/books/{key}", json={"title": None}, headers=headers)
    assert response.status_code == 400


def test_delete_book(client: TestClient, headers: dict[str, str]) -> None:
    created = create_book(client, headers)
    key = created["id"]
    response = client.delete(f"/books/{key}", headers=headers)
    assert response.status_code == 204, response.text
    assert client.get(f"/books/{key}", headers=headers).status_code == 404
