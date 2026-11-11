"""Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."""

from typing import Any

from django.test import override_settings
from rest_framework.test import APIClient

# The settings every test runs with
TEST_SETTINGS = override_settings()


def authorize(client: APIClient, roles: list[str] | None = None) -> APIClient:
    """Gives the client the credentials to call every endpoint (or, with roles, only those roles)."""
    return client


def category_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one category, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1"} if variant == 0 else {"name": "name 2"}
    return body


def create_category(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one category and returns it as the API answers."""
    response = client.post("/categories", category_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()


def item_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one item, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1", "price": 0, "supplierEmail": "user1@example.com", "categoryId": None, "stock": 0} if variant == 0 else {"name": "name 2", "price": 0.5, "supplierEmail": "user2@example.com", "categoryId": None, "stock": 1}
    body["categoryId"] = create_category(client)["id"]
    return body


def create_item(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one item and returns it as the API answers."""
    response = client.post("/items", item_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()
