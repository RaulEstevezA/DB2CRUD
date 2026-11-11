"""Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."""

from typing import Any

from django.test import override_settings
from rest_framework.test import APIClient

# The settings every test runs with
TEST_SETTINGS = override_settings()


def authorize(client: APIClient, roles: list[str] | None = None) -> APIClient:
    """Gives the client the credentials to call every endpoint (or, with roles, only those roles)."""
    return client


def customer_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one customer, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1", "email": "email 1", "password": "password 1", "phone": "phone 1", "address": {"street": "street 1", "city": "city 1", "postalCode": "postalCode 1", "country": "country 1"}} if variant == 0 else {"name": "name 2", "email": "email 2", "password": "password 2", "phone": "phone 2", "address": {"street": "street 2", "city": "city 2", "postalCode": "postalCode 2", "country": "country 2"}}
    return body


def create_customer(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one customer and returns it as the API answers."""
    response = client.post("/customers", customer_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()


def product_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one product, with the items it refers to created first."""
    body: dict[str, Any] = {"sku": "sku 1", "name": "name 1", "description": "description 1", "price": 1.5, "stock": 1.5, "active": True} if variant == 0 else {"sku": "sku 2", "name": "name 2", "description": "description 2", "price": 2, "stock": 2, "active": False}
    return body


def create_product(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one product and returns it as the API answers."""
    response = client.post("/products", product_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()


def order_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """A valid body to create one order, with the items it refers to created first."""
    body: dict[str, Any] = {"customerId": None, "lines": [{"productId": None, "quantity": 1.5, "unitPrice": 1.5}], "status": "pending", "total": 1.5, "notes": "notes 1"} if variant == 0 else {"customerId": None, "lines": [{"productId": None, "quantity": 2, "unitPrice": 2}], "status": "paid", "total": 2, "notes": "notes 2"}
    body["customerId"] = create_customer(client)["id"]
    body["lines"][0]["productId"] = create_product(client)["id"]
    return body


def create_order(client: APIClient, variant: int = 0) -> dict[str, Any]:
    """Creates one order and returns it as the API answers."""
    response = client.post("/orders", order_payload(client, variant), format="json")
    assert response.status_code == 201, response.content
    return response.json()
