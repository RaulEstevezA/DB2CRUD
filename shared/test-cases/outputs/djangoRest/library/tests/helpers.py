"""Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."""

from typing import Any

from django.test import override_settings
from rest_framework.test import APIClient

# The settings every test runs with
TEST_SETTINGS = override_settings()


def authorize(client: APIClient, roles: list[str] | None = None) -> APIClient:
    """Gives the client the credentials to call every endpoint (or, with roles, only those roles)."""
    return client


def author_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one author, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1", "email": "user1@example.com", "born": "2024-01-15"} if variant == 0 else {"name": "name 2", "email": "user2@example.com", "born": "2024-01-16"}
    return body


def create_author(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one author and returns it as the API answers."""
    response = client.post("/authors", author_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()


def book_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one book, with the items it refers to created first."""
    body: dict[str, Any] = {"title": "title 1", "isbn": "0000000000000", "authorId": None, "genre": "novel", "pages": 1, "published": "2024-01-15", "available": True} if variant == 0 else {"title": "title 2", "isbn": "0000000000000", "authorId": None, "genre": "essay", "pages": 2, "published": "2024-01-16", "available": False}
    body["authorId"] = create_author(client)["id"]
    return body


def create_book(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one book and returns it as the API answers."""
    response = client.post("/books", book_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()
