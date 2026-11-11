/**
 * Built-in examples: invented models saved as Model2DB projects, built with Model2DB's own code (the copy in
 * core/interop/model2db/vendor), each with a different output so the examples show different inputs. They are
 * also fixtures of the interface tests.
 */
import { createProject } from '../core/interop/model2db/vendor/interop/project.ts'
import { DEFAULT_NAMING } from '../core/interop/model2db/vendor/physical/naming.ts'
import type { InputFormatId } from '../core/interop/model2db/vendor/parsers/types.ts'
import type { Dialect } from '../core/interop/model2db/vendor/physical/types.ts'

export type ExampleId = 'store' | 'library' | 'catalog'

export interface Example {
  id: ExampleId
  /** Name of the generated project */
  project: string
  /** The model2db-project file, as Model2DB saves it */
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
/** A Model2DB project of these models, with this output and engine, as Model2DB saves it. */
function model2dbProject(format: InputFormatId, text: string, output: string, engine: Dialect): string {
  const project = createProject(
    { format, text },
    { relational: null, document: null, keyvalue: null, widecolumn: null },
    { output, naming: DEFAULT_NAMING, strings: 'auto', engine, migrations: false },
    new Date('2026-11-11T12:00:00.000Z'),
  )
  return `${JSON.stringify(project, null, 2)}\n`
}

export const EXAMPLES: readonly Example[] = [
  { id: 'store', project: 'shop-data', text: model2dbProject('typescript', STORE, 'postgresql', 'postgresql') },
  { id: 'library', project: 'library-data', text: model2dbProject('python', LIBRARY, 'sqlalchemy', 'postgresql') },
  { id: 'catalog', project: 'catalog-data', text: model2dbProject('java', CATALOG, 'mysql', 'mysql') },
]

export function findExample(id: ExampleId): Example | undefined {
  return EXAMPLES.find((example) => example.id === id)
}
