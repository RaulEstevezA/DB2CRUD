"""Builders of valid request bodies, and helpers that create items through the API."""

from typing import Any

from fastapi.testclient import TestClient


def customer_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create a customer, with the items it refers to created first."""
    body: dict[str, Any] = {"name": "name 1", "email": "email 1", "password": "password 1", "phone": "phone 1", "address": {"street": "street 1", "city": "city 1", "postalCode": "postalCode 1", "country": "country 1"}} if variant == 0 else {"name": "name 2", "email": "email 2", "password": "password 2", "phone": "phone 2", "address": {"street": "street 2", "city": "city 2", "postalCode": "postalCode 2", "country": "country 2"}}
    return body


def create_customer(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates a customer and returns it as the API answers."""
    response = client.post("/customers", json=customer_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def product_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create a product, with the items it refers to created first."""
    body: dict[str, Any] = {"sku": "sku 1", "name": "name 1", "description": "description 1", "price": 1.5, "stock": 1.5, "active": True} if variant == 0 else {"sku": "sku 2", "name": "name 2", "description": "description 2", "price": 2, "stock": 2, "active": False}
    return body


def create_product(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates a product and returns it as the API answers."""
    response = client.post("/products", json=product_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def order_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """A valid body to create an order, with the items it refers to created first."""
    body: dict[str, Any] = {"customerId": None, "lines": [{"productId": None, "quantity": 1.5, "unitPrice": 1.5}], "status": "pending", "total": 1.5, "notes": "notes 1"} if variant == 0 else {"customerId": None, "lines": [{"productId": None, "quantity": 2, "unitPrice": 2}], "status": "paid", "total": 2, "notes": "notes 2"}
    body["customerId"] = create_customer(client, headers)["id"]
    body["lines"][0]["productId"] = create_product(client, headers)["id"]
    return body


def create_order(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:
    """Creates an order and returns it as the API answers."""
    response = client.post("/orders", json=order_payload(client, headers, variant), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()
