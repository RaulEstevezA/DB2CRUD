"""Request and response schemas of customers."""

from datetime import datetime
from typing import ClassVar

from pydantic import BaseModel, Field

from app.schemas.common import Address
from app.validators import ApiModel, ResponseModel


class CustomerCreate(ApiModel):
    """Body of a request that creates or replaces a customer."""

    name: str
    email: str
    password: str
    phone: str | None = None
    address: Address

    non_nullable: ClassVar[frozenset[str]] = frozenset({"phone"})


class CustomerUpdate(ApiModel):
    """Body of a request that changes part of a customer: only the fields sent change."""

    name: str | None = None
    email: str | None = None
    password: str | None = None
    phone: str | None = None
    address: Address | None = None

    non_nullable: ClassVar[frozenset[str]] = frozenset({"name", "email", "password", "phone", "address"})


class Customer(ResponseModel):
    """A customer as the API returns it."""

    id: int
    name: str
    email: str
    phone: str | None = None
    address: Address
    created_at: datetime = Field(..., alias="createdAt")


class CustomerPage(BaseModel):
    """One page of customers."""

    items: list[Customer]
    total: int
    page: int
    size: int
