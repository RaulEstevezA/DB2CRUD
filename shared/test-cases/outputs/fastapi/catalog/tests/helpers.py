"""Builders of valid request bodies, and helpers that create items through the API."""

from typing import Any

from fastapi.testclient import TestClient


def category_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create a category, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1"} if variant == 0 else {"name": "name 2"}
    return body


def create_category(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates a category and returns it as the API answers."""
    response = client.post("/categories", json=category_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def item_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create an item, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1", "price": 0, "supplierEmail": "user1@example.com", "categoryId": None, "stock": 0} if variant == 0 else {"name": "name 2", "price": 0.5, "supplierEmail": "user2@example.com", "categoryId": None, "stock": 1}
    body["categoryId"] = create_category(client, headers)["id"]
    return body


def create_item(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates an item and returns it as the API answers."""
    response = client.post("/items", json=item_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()
