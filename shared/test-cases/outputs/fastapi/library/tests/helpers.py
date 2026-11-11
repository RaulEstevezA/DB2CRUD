"""Builders of valid request bodies, and helpers that create items through the API."""

from typing import Any

from fastapi.testclient import TestClient


def author_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create an author, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1", "email": "user1@example.com", "born": "2024-01-15"} if variant == 0 else {"name": "name 2", "email": "user2@example.com", "born": "2024-01-16"}
    return body


def create_author(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates an author and returns it as the API answers."""
    response = client.post("/authors", json=author_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def book_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create a book, with the items it refers to created first."""
    body: dict[str, Any] = {"title": "title 1", "isbn": "0000000000000", "authorId": None, "genre": "novel", "pages": 1, "published": "2024-01-15", "available": True} if variant == 0 else {"title": "title 2", "isbn": "0000000000000", "authorId": None, "genre": "essay", "pages": 2, "published": "2024-01-16", "available": False}
    body["authorId"] = create_author(client, headers)["id"]
    return body


def create_book(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates a book and returns it as the API answers."""
    response = client.post("/books", json=book_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()
