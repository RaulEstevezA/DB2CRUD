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

/** The same documents, identified by texts. */
export const BLOG_TEXT_MODELS = BLOG_MODELS.replaceAll('id: UUID', 'id: str')

/** The models of the projects of verification scenarios, by name. */
const MODELS = {
  shop: [SHOP_MODELS, 'typescript'],
  blog: [BLOG_MODELS, 'python'],
  blogTexts: [BLOG_TEXT_MODELS, 'python'],
  notes: [NOTES_MODELS, 'prisma'],
} as const

export interface ScenarioProject {
  models: keyof typeof MODELS
  output: string
}

/** The project of a verification scenario (verification/scenarios/index.mjs). */
export function scenarioProject({ models, output }: ScenarioProject): string {
  const [text, format] = MODELS[models]
  return shopProject(output, 'postgresql', text, format)
}
