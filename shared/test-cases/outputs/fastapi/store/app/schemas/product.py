"""Request and response schemas of products."""

from typing import ClassVar

from pydantic import BaseModel

from app.validators import ApiModel, ResponseModel


class ProductCreate(ApiModel):
    """Body of a request that creates or replaces a product."""

    sku: str
    name: str
    description: str | None = None
    price: float
    stock: float
    active: bool

    non_nullable: ClassVar[frozenset[str]] = frozenset({"description"})


class ProductUpdate(ApiModel):
    """Body of a request that changes part of a product: only the fields sent change."""

    sku: str | None = None
    name: str | None = None
    description: str | None = None
    price: float | None = None
    stock: float | None = None
    active: bool | None = None

    non_nullable: ClassVar[frozenset[str]] = frozenset({"sku", "name", "description", "price", "stock", "active"})


class Product(ResponseModel):
    """A product as the API returns it."""

    id: int
    sku: str
    name: str
    description: str | None = None
    price: float
    stock: float
    active: bool


class ProductPage(BaseModel):
    """One page of products."""

    items: list[Product]
    total: int
    page: int
    size: int
