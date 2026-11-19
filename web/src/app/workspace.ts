/**
 * Workspace logic the interface uses, kept out of the components so it can be tested: reading the database
 * input and counting what was read.
 */
import { ORM_READERS, detectOrm, readOrmCode } from '../core/importers/orm/registry.ts'
import { readModel2DBProject, type Model2DBReadError } from '../core/interop/model2db/read.ts'
import type { DbSchema } from '../core/schema/types.ts'

export interface InputState {
  text: string
  /** File name it was opened from */
  fileName?: string
}

export const EMPTY_INPUT: InputState = { text: '' }

export type DatabaseReadError = Model2DBReadError | 'unknownInput' | 'noTables'

export type DatabaseReadResult = { ok: true; schema: DbSchema } | { ok: false; error: DatabaseReadError; path?: string }

/** The physical schema of the input, or why it cannot be read; null while the input is empty. A JSON text is a
 * Model2DB project; anything else is ORM code. */
export function readDatabase(input: InputState): DatabaseReadResult | null {
  const text = input.text.trim()
  if (text === '') return null
  if (text.startsWith('{')) return readModel2DBProject(input.text)
  const read = readOrmCode([{ name: input.fileName ?? 'input', text: input.text }])
  if (read.ok) return { ok: true, schema: read.schema }
  return { ok: false, error: read.error === 'unknownOrm' ? 'unknownInput' : read.error }
}

/** The language of the input, for the editor's highlighting: JSON for a project, the ORM's for its code. */
export function inputLanguage(input: InputState): string {
  const text = input.text.trimStart()
  if (text === '' || text.startsWith('{')) return 'json'
  return detectOrm([{ name: input.fileName ?? 'input', text: input.text }])?.language ?? 'text'
}

/** What the schema was read from, for the summary: `Model2DB (prisma)`, `SQLAlchemy`. */
export function sourceLabel(schema: DbSchema): string {
  const { kind, format } = schema.source
  if (kind === 'model2db') return `Model2DB (${format})`
  return ORM_READERS.find((reader) => reader.id === format)?.label ?? format
}

/** Count of columns in every table. */
export function columnCount(schema: DbSchema): number {
  return schema.tables.reduce((total, table) => total + table.columns.length, 0)
}
