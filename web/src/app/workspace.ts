/**
 * Workspace logic the interface uses, kept out of the components so it can be tested: reading the database
 * input and counting what was read.
 */
import { detectDdl, readDdl } from '../core/importers/ddl/ddl.ts'
import { acceptedExtensions, detectFormat, findParser, parseInput } from '../core/importers/registry.ts'
import { ORM_READERS, detectOrm, readOrmCode } from '../core/importers/orm/registry.ts'
import { readModel2DBProject, type Model2DBReadError } from '../core/interop/model2db/read.ts'
import type { ModelSchema } from '../core/model/schema.ts'
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
 * Model2DB project; anything else is ORM code, or else SQL DDL. */
export function readDatabase(input: InputState): DatabaseReadResult | null {
  const text = input.text.trim()
  if (text === '') return null
  if (text.startsWith('{')) return readModel2DBProject(input.text)
  const read = readOrmCode([{ name: input.fileName ?? 'input', text: input.text }])
  if (read.ok) return { ok: true, schema: read.schema }
  if (read.error === 'unknownOrm' && detectDdl(input.text)) {
    const schema = readDdl(input.text)
    return schema.tables.length > 0 ? { ok: true, schema } : { ok: false, error: 'noTables' }
  }
  return { ok: false, error: read.error === 'unknownOrm' ? 'unknownInput' : read.error }
}

/** The language of the input, for the editor's highlighting: JSON for a project, the ORM's for its code, SQL for DDL. */
export function inputLanguage(input: InputState): string {
  const text = input.text.trimStart()
  if (text === '' || text.startsWith('{')) return 'json'
  return detectOrm([{ name: input.fileName ?? 'input', text: input.text }])?.language ?? (detectDdl(input.text) ? 'sql' : 'text')
}

/** What the schema was read from, for the summary: `Model2DB (prisma)`, `SQLAlchemy`, `SQL DDL`. */
export function sourceLabel(schema: DbSchema): string {
  const { kind, format } = schema.source
  if (kind === 'model2db') return `Model2DB (${format})`
  if (kind === 'ddl') return 'SQL DDL'
  return ORM_READERS.find((reader) => reader.id === format)?.label ?? format
}

/** Count of columns in every table. */
export function columnCount(schema: DbSchema): number {
  return schema.tables.reduce((total, table) => total + table.columns.length, 0)
}

// Application models

export type ModelsReadResult = { ok: true; schema: ModelSchema; format: string } | { ok: false; error: string }

/** The application models of their input (classes, DTOs, JSON, schemas…), or why they cannot be read; null while it
 * is empty. They are optional: without them the services work with the entities. */
export function readModels(input: InputState): ModelsReadResult | null {
  if (input.text.trim() === '') return null
  const format = detectFormat(input.text, input.fileName)
  if (!format) return { ok: false, error: 'unknownFormat' }
  const read = parseInput(input.text, format, { rootName: 'Root' })
  if (!read.ok) return { ok: false, error: read.error.code }
  if (read.schema.models.length === 0) return { ok: false, error: 'noModels' }
  return { ok: true, schema: read.schema, format: findParser(format)?.label ?? format }
}

/** The highlighting of the models input: the language of their format. */
export function modelsLanguage(input: InputState): string {
  const format = input.text.trim() === '' ? null : detectFormat(input.text, input.fileName)
  return (format && findParser(format)?.editorLanguage) || 'text'
}

/** The extensions the models input opens. */
export const MODEL_EXTENSIONS = acceptedExtensions().join(',')
