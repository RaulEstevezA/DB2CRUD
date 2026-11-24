"""Beanie documents written by Model2DB from Order. Pass the Document classes to init_beanie(). Review them before using them."""

import datetime
import enum

from beanie import Document, Link
from pydantic import BaseModel, Field


class OrderStatus(str, enum.Enum):
    DRAFT = "draft"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class Customer(BaseModel):
    id: float
    email: str
    fullName: str = Field(alias="full_name")
    phone: str | None = Field(default=None)
    shippingAddress: "Address" = Field(alias="shipping_address")
    createdAt: datetime.datetime = Field(alias="created_at")


class Address(BaseModel):
    street: str
    city: str
    postalCode: str = Field(alias="postal_code")
    country: str


class OrderLine(BaseModel):
    quantity: float
    unitPrice: float = Field(alias="unit_price")


# TODO: decide how "Order.lines.product" is stored (pending in the design).
class Order(Document):
    id: float = Field(alias="_id")
    customer: "Customer"
    status: OrderStatus
    lines: "list[OrderLine]" = Field(default_factory=list)
    couponCode: str | None = Field(default=None, alias="coupon_code")
    tags: list[str] = Field(default_factory=list)
    placedAt: datetime.datetime = Field(alias="placed_at")

    class Settings:
        name = "orders"


class Product(Document):
    id: float = Field(alias="_id")
    sku: str
    name: str
    price: float
    categories: "list[Link[Category]]" = Field(default_factory=list)
    attributes: dict[str, str]

    class Settings:
        name = "products"


class Category(Document):
    id: float = Field(alias="_id")
    name: str
    products: "list[Link[Product]]" = Field(default_factory=list)

    class Settings:
        name = "categories"
