"""Beanie documents written by Model2DB from Invoice. Pass the Document classes to init_beanie(). Review them before using them."""

import datetime
from typing import Any

from beanie import Document
from pydantic import BaseModel, Field


class Customer(BaseModel):
    customer_id: int
    name: str
    email: str
    billing_address: "BillingAddress"


class BillingAddress(BaseModel):
    street: str
    city: str
    zip_code: str


class Line(BaseModel):
    description: str
    qty: int
    unit_price: float
    tax_rate: float


class Invoice(Document):
    id: int = Field(alias="_id")
    number: str
    issued_at: datetime.datetime
    currency: str
    paid: bool
    customer: "Customer"
    lines: "list[Line]" = Field(default_factory=list)
    notes: Any | None = Field(default=None)
    labels: list[str] = Field(default_factory=list)

    class Settings:
        name = "invoices"
