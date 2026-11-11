/**
 * Model2DB projects built with Model2DB's own code (the copy in vendor/), from invented models, for the tests of
 * the reader. Designs are left null, as in a project saved before any decision was made: Model2DB proposes them
 * again when the project is opened, and so does the reader.
 */
import { createProject } from '../vendor/interop/project.ts'
import { DEFAULT_NAMING } from '../vendor/physical/naming.ts'
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

/** A project as Model2DB saves it, for these models and this output. */
export function shopProject(output: string, engine: Dialect = 'postgresql', text = SHOP_MODELS): string {
  const project = createProject(
    { format: 'typescript', text },
    { relational: null, document: null, keyvalue: null, widecolumn: null },
    { output, naming: DEFAULT_NAMING, strings: 'auto', engine, migrations: false },
    new Date('2026-11-11T12:00:00.000Z'),
  )
  return JSON.stringify(project)
}
