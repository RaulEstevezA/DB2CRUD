from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum


class Level(str, Enum):
    BASIC = "basic"
    GOLD = "gold"


class LineStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"


@dataclass
class Location:
    latitude: float
    longitude: float


@dataclass
class Address:
    street: str
    zip_code: str
    location: Location | None


@dataclass
class Customer:
    id: str
    email: str
    level: Level | None
    since: datetime
    address: Address
    tags: list[str]


@dataclass
class Discount:
    reason: str
    percent: float


@dataclass
class OrderLine:
    id: str | None
    sku: str
    quantity: int
    price: Decimal
    status: LineStatus | None
    discounts: list[Discount]


@dataclass
class Shipping:
    carrier: str
    sent_on: date


@dataclass
class Order:
    id: str
    code: str
    lines: list[OrderLine]
    shipping: Shipping | None


@dataclass
class Parcel:
    weight: float
    size: str
    fragile: bool


@dataclass
class Shipment:
    id: str
    parcel: Parcel
    stops: list[str]
