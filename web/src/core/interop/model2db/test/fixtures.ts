/**
 * Model2DB projects built with Model2DB's own code (the copy in vendor/), from invented models, for the tests of
 * the reader. Designs are left null, as in a project saved before any decision was made: Model2DB proposes them
 * again when the project is opened, and so does the reader.
 */
import { createProject } from '../vendor/interop/project.ts'
import { DEFAULT_NAMING } from '../vendor/physical/naming.ts'
import type { InputFormatId } from '../vendor/parsers/types.ts'
import type { Dialect } from '../vendor/physical/types.ts'

export const SHOP_MODELS = `export interface Customer {
  id: number
  /** @maxLength 120 */
  email: string
  name: string
  orders: Order[]
}

export interface Order {
  id: number
  customer: Customer
  status: 'new' | 'paid' | 'sent'
  total: number
  placedAt: Date
  lines: OrderLine[]
}

export interface OrderLine {
  product: string
  quantity: number
}
`

/** UUIDs as keys, as references and inside documents, which each library stores in its own way. */
export const BLOG_MODELS = `from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

@dataclass
class Author:
    id: UUID
    email: str
    posts: list["Post"]

@dataclass
class Post:
    id: UUID
    title: str
    author: Author
    published_at: datetime | None
    comments: list["Comment"]

@dataclass
class Comment:
    id: UUID
    text: str
    marks: list[UUID]
`

/** A reference next to the field that keeps its identifier. */
export const NOTES_MODELS = `model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  notes Note[]
}

model Note {
  id       Int    @id @default(autoincrement())
  text     String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`

/** A project as Model2DB saves it, for these models and this output. */
export function shopProject(
  output: string,
  engine: Dialect = 'postgresql',
  text = SHOP_MODELS,
  format: InputFormatId = 'typescript',
): string {
  const project = createProject(
    { format, text },
    { relational: null, document: null, keyvalue: null, widecolumn: null },
    { output, naming: DEFAULT_NAMING, strings: 'auto', engine, migrations: false },
    new Date('2026-11-11T12:00:00.000Z'),
  )
  return JSON.stringify(project)
}
