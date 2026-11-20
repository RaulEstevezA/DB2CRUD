from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum


class ProductStatus(str, Enum):
    DRAFT = "draft"
    LIVE = "live"


@dataclass
class Customer:
    """A customer of the shop"""

    id: int
    email: str
    password_hash: str


@dataclass
class CategoryDto:
    id: int
    name: str


@dataclass
class Product:
    id: int
    name: str
    price: Decimal
    status: ProductStatus
    category_name: str
    tag_ids: list[int] = field(default_factory=list)
