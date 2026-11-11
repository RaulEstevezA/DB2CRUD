"""Enums and embedded objects shared by the resources."""

from enum import Enum

from pydantic import Field

from app.validators import ApiModel


class OrderStatus(str, Enum):
    """Values of OrderStatus."""

    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class Address(ApiModel):
    """Address, embedded in the resources that hold it."""

    street: str
    city: str
    postal_code: str = Field(..., alias="postalCode")
    country: str


class OrderLine(ApiModel):
    """OrderLine, embedded in the resources that hold it."""

    product_id: int = Field(..., alias="productId")
    quantity: float
    unit_price: float = Field(..., alias="unitPrice")
