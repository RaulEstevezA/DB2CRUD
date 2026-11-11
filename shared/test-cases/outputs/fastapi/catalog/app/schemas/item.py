"""Request and response schemas of items."""

from decimal import Decimal
from typing import ClassVar

from pydantic import BaseModel, EmailStr, Field

from app.validators import ApiModel, DecimalNumber, ResponseModel


class ItemCreate(ApiModel):
    """Body of a request that creates or replaces an item."""

    name: str = Field(..., min_length=3, max_length=120)
    price: DecimalNumber = Field(..., ge=0)
    supplier_email: EmailStr = Field(..., alias="supplierEmail")
    category_id: int = Field(..., alias="categoryId")
    stock: int = Field(..., ge=0)


class ItemUpdate(ApiModel):
    """Body of a request that changes part of an item: only the fields sent change."""

    name: str | None = Field(default=None, min_length=3, max_length=120)
    price: DecimalNumber | None = Field(default=None, ge=0)
    supplier_email: EmailStr | None = Field(default=None, alias="supplierEmail")
    category_id: int | None = Field(default=None, alias="categoryId")
    stock: int | None = Field(default=None, ge=0)

    non_nullable: ClassVar[frozenset[str]] = frozenset({"name", "price", "supplier_email", "category_id", "stock"})


class Item(ResponseModel):
    """An item as the API returns it."""

    id: int
    name: str = Field(..., min_length=3, max_length=120)
    price: DecimalNumber = Field(..., ge=0)
    supplier_email: EmailStr = Field(..., alias="supplierEmail")
    category_id: int = Field(..., alias="categoryId")
    stock: int = Field(..., ge=0)


class ItemPage(BaseModel):
    """One page of items."""

    items: list[Item]
    total: int
    page: int
    size: int
