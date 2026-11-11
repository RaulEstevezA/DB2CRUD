"""Built-in examples: invented models saved as Model2DB projects, built with Model2DB's own code. The same as
web/src/examples/index.ts, character by character."""

import json
from datetime import UTC, datetime

from .core.interop.model2db.vendor.interop.project import create_project
from .core.interop.model2db.vendor.physical.naming import DEFAULT_NAMING

STORE = """\
// Online shop: customers, products and orders
export enum OrderStatus {
  Pending = 'pending',
  Paid = 'paid',
  Shipped = 'shipped',
  Cancelled = 'cancelled',
}

export interface Address {
  street: string
  city: string
  postalCode: string
  country: string
}

export interface Customer {
  id: number
  name: string
  email: string
  password: string
  phone?: string
  address: Address
  createdAt: Date
}

export interface Product {
  id: number
  sku: string
  name: string
  description?: string
  price: number
  stock: number
  active: boolean
}

export interface OrderLine {
  product: Product
  quantity: number
  unitPrice: number
}

export interface Order {
  id: number
  customer: Customer
  lines: OrderLine[]
  status: OrderStatus
  total: number
  notes?: string | null
  createdAt: Date
  updatedAt: Date
}
"""

LIBRARY = """\
# Library: authors and books, with Pydantic validations
from datetime import date
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class Genre(str, Enum):
    NOVEL = "novel"
    ESSAY = "essay"
    POETRY = "poetry"
    SCIENCE = "science"


class Author(BaseModel):
    id: UUID
    name: str = Field(..., min_length=2, max_length=120)
    email: Optional[EmailStr] = None
    born: Optional[date] = None


class Book(BaseModel):
    id: UUID
    title: str = Field(..., min_length=1, max_length=200)
    isbn: str = Field(..., pattern=r"^[0-9]{13}$")
    author: Author
    genre: Genre
    pages: int = Field(..., ge=1, le=5000)
    published: Optional[date] = None
    available: bool = True
"""

CATALOG = """\
// Catalogue: JPA entities with Bean Validation
@Entity
public class Category {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @NotBlank
    @Size(max = 80)
    private String name;

    private Category parent;
}

@Entity
public class Item {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @NotBlank
    @Size(min = 3, max = 120)
    private String name;

    @DecimalMin("0.00")
    private BigDecimal price;

    @Email
    private String supplierEmail;

    private Category category;

    @Min(0)
    private int stock;
}
"""


def _model2db_project(format_id: str, text: str, output: str, engine: str) -> str:
    """A Model2DB project of these models, with this output and engine, as Model2DB saves it."""
    project = create_project(
        {"format": format_id, "text": text},
        {"relational": None, "document": None, "keyvalue": None, "widecolumn": None},
        {"output": output, "naming": DEFAULT_NAMING, "strings": "auto", "engine": engine, "migrations": False},
        datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC),
    )
    return json.dumps(project, indent=2, ensure_ascii=False) + "\n"


# Every example, in the order the interface shows them
EXAMPLES = (
    {"id": "store", "project": "shop-data", "text": _model2db_project("typescript", STORE, "postgresql", "postgresql")},
    {
        "id": "library",
        "project": "library-data",
        "text": _model2db_project("python", LIBRARY, "sqlalchemy", "postgresql"),
    },
    {"id": "catalog", "project": "catalog-data", "text": _model2db_project("java", CATALOG, "mysql", "mysql")},
)


def find_example(example_id: str) -> dict | None:
    return next((example for example in EXAMPLES if example["id"] == example_id), None)
