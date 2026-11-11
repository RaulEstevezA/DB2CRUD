"""Request and response schemas of orders."""

from datetime import datetime
from typing import ClassVar

from pydantic import BaseModel, Field

from app.schemas.common import OrderLine, OrderStatus
from app.validators import ApiModel, ResponseModel


class OrderCreate(ApiModel):
    """Body of a request that creates or replaces an order."""

    customer_id: int = Field(..., alias="customerId")
    lines: list[OrderLine]
    status: OrderStatus
    total: float
    notes: str | None = None


class OrderUpdate(ApiModel):
    """Body of a request that changes part of an order: only the fields sent change."""

    customer_id: int | None = Field(default=None, alias="customerId")
    lines: list[OrderLine] | None = None
    status: OrderStatus | None = None
    total: float | None = None
    notes: str | None = None

    non_nullable: ClassVar[frozenset[str]] = frozenset({"customer_id", "lines", "status", "total"})


class Order(ResponseModel):
    """An order as the API returns it."""

    id: int
    customer_id: int = Field(..., alias="customerId")
    lines: list[OrderLine]
    status: OrderStatus
    total: float
    notes: str | None = None
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")


class OrderPage(BaseModel):
    """One page of orders."""

    items: list[Order]
    total: int
    page: int
    size: int
