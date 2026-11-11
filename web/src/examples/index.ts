/**
 * Built-in examples: invented models that show what DB2CRUD reads. They are also fixtures of the
 * interface tests.
 */
import type { InputFormatId } from '../core/importers/types.ts'

export type ExampleId = 'store' | 'library' | 'catalog'

export interface Example {
  id: ExampleId
  format: InputFormatId
  /** Name of the generated project */
  project: string
  text: string
}

const STORE = `// Online shop: customers, products and orders
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
`

const LIBRARY = `# Library: authors and books, with Pydantic validations
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
`

const CATALOG = `// Catalogue: JPA entities with Bean Validation
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
`

/** Every example, in the order the interface shows them. */
export const EXAMPLES: readonly Example[] = [
  { id: 'store', format: 'typescript', project: 'shop-api', text: STORE },
  { id: 'library', format: 'python', project: 'library-api', text: LIBRARY },
  { id: 'catalog', format: 'java', project: 'catalog-api', text: CATALOG },
]

export function findExample(id: ExampleId): Example | undefined {
  return EXAMPLES.find((example) => example.id === id)
}
