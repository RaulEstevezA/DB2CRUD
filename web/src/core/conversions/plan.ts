/**
 * The conversions between the application models and the tables, as a plan every generator writes in its language
 * (docs/design.md, section 2). For each table with a model, the plan says where each value a write sends comes from
 * in the model (a field, a row looked up by a field, a Mapper transformation) and where each field of the model
 * comes from in a row it reads. What the matching leaves undecided, or what cannot be converted that way, is a
 * `todo`: the generated code says so instead of guessing.
 *
 * Conversions are written only when the models are in the language of the project, or in a format of no language
 * (JSON, JSON Schema, OpenAPI…): otherwise the services keep their DTOs and the interface says why.
 */
import type { CrudDesign } from '../crud/types.ts'
import type { MapperField, MapperProject, MapperTransform } from '../interop/mapper/read.ts'
import type { ChildrenMatch, ColumnMatch, ModelMatch } from '../matching/matching.ts'
import { compatible } from '../matching/matching.ts'
import { fieldFor, fieldsOf } from '../matching/names.ts'
import { modelOf, type FieldDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import { nestedFields } from '../schema/documents.ts'
import type { DbColumn, DbSchema, DbTable, DbType } from '../schema/types.ts'
import type { LanguageId } from '../settings/settings.ts'

/** The application models a project is generated with. */
export interface ApplicationModels {
  schema: ModelSchema
  /** The Mapper project they come from, when they do */
  project?: MapperProject | null
}

/** A path in a model: `['address', 'city']`. */
export type ModelPath = string[]

/** Why a value is left to the user. */
export type TodoReason =
  /** The matching proposed it, but it waits for review */
  | 'pending'
  /** No field of the model gives it, and the table needs it */
  | 'noField'
  /** Mapper's relation only goes the other way */
  | 'oneWay'
  /** A Mapper transformation the generators do not write (`expression`, `object`, `collection`), or a list of
   * rows that are not keys */
  | 'unsupported'
  /** A column the service never returns (one of the table's hidden columns), so the model cannot be read from it */
  | 'hidden'

export interface Todo {
  kind: 'todo'
  reason: TodoReason
  /** What it is about, for the comment: the fields or the expression */
  detail?: string
}

/** Where a value written into a column comes from in the model. */
export type WriteValue =
  | { kind: 'field'; path: ModelPath }
  /** The `key` of the row of `table` whose `by` column has the field's value */
  | { kind: 'lookup'; path: ModelPath; table: string; by: string; key: string }
  /** A Mapper transformation of the model's fields */
  | { kind: 'mapper'; transform: MapperTransform; sources: ModelPath[] }
  /** The inverse of a Mapper transformation that reads the column into the field */
  | { kind: 'inverse'; transform: MapperTransform; path: ModelPath }
  /**
   * A nested document (or a list of them) from the nested model of a field: a value per field of the document.
   * `unused`: the fields of the model the document does not keep
   */
  | {
      kind: 'document'
      path: ModelPath
      model: string
      many: boolean
      values: { column: string; value: WriteValue }[]
      unused: string[]
    }
  | Todo

/** Where a field of the model comes from in a row read. */
export type ReadValue =
  | { kind: 'column'; column: string }
  /** The `by` column of the row of `table` whose `key` is the column's value */
  | { kind: 'lookup'; column: string; table: string; by: string; key: string }
  /** A Mapper transformation of the row's columns */
  | { kind: 'mapper'; transform: MapperTransform; columns: string[] }
  /** The inverse of a Mapper transformation that writes the field into the column */
  | { kind: 'inverse'; transform: MapperTransform; column: string }
  /** A list of the `value` column of the rows of `table` whose `by` column is this row's `key` (a join table) */
  | { kind: 'children'; table: string; by: string; key: string; value: string }
  /** The nested model of a field (or a list of them) from a nested document: a value per field of the model */
  | { kind: 'document'; column: string; model: string; many: boolean; values: { field: string; value: ReadValue }[] }
  | Todo

export interface ConversionPlan {
  table: string
  model: string
  direction: ModelMatch['direction']
  /** Model → table: one value per column the model fills, in the table's order; null for a model that only reads */
  write: { column: string; value: WriteValue }[] | null
  /** Table → model: one value per field of the model it can fill; null for a model that only writes */
  read: { field: string; value: ReadValue }[] | null
}

/** Whether something is left to the user, inside documents too. */
export const hasTodo = (items: { value: WriteValue | ReadValue }[] | null): boolean =>
  (items ?? []).some(({ value }) => value.kind === 'todo' || (value.kind === 'document' && hasTodo(value.values)))

/** Whether reading a column into a field loses part of it, so writing it back may give another value: a date without its
 * time, an exact number as a binary one, a number without its decimals. */
function narrows(type: TypeRef, column: DbType): boolean {
  if (type.kind === 'array') return column.kind === 'array' && narrows(type.items, column.items)
  if (type.kind !== 'primitive') return false
  if (type.name === 'date') return column.kind === 'datetime'
  if (type.name === 'integer') return column.kind === 'float' || column.kind === 'decimal'
  return type.name === 'float' && column.kind === 'decimal'
}

/** Whether a value written into a column of a document database may differ from the one it was read from. */
export function lossy(value: WriteValue, column: DbType, fields: FieldDef[], models: ModelSchema): boolean {
  if (value.kind === 'field') {
    const field = fields.find((item) => item.name === value.path[0])
    return field !== undefined && narrows(field.type, column)
  }
  if (value.kind !== 'document') return false
  const model = models.models.find((item) => item.name === value.model)
  const columns = nestedFields(column) ?? []
  return value.values.some((item) => {
    const inner = columns.find((candidate) => candidate.name === item.column)
    return inner !== undefined && model !== undefined && lossy(item.value, inner.type, fieldsOf(model, models), models)
  })
}

/** The columns a value read from a row uses. */
function readColumns(value: ReadValue): string[] {
  switch (value.kind) {
    case 'column':
    case 'lookup':
    case 'inverse':
    case 'document':
      return [value.column]
    case 'mapper':
      return value.columns
    case 'children':
      return [value.key]
    case 'todo':
      return []
  }
}

/**
 * A plan read from what the service returns, which leaves out the hidden columns: the fields that need one of them
 * are left to the user.
 */
export function withoutHidden(plan: ConversionPlan, hidden: string[]): ConversionPlan {
  if (!plan.read || hidden.length === 0) return plan
  const read = plan.read.map((item) => {
    const used = readColumns(item.value).filter((column) => hidden.includes(column))
    return used.length > 0 ? { ...item, value: { kind: 'todo', reason: 'hidden', detail: used.join(', ') } satisfies Todo } : item
  })
  return { ...plan, read }
}

/** The language the models are written in, or null for a format of no language. */
export function modelsLanguage(models: ApplicationModels, model?: string): string | null {
  const project = models.project
  if (project && model) {
    const side = project.source.schema.models.some((item) => item.name === model) ? project.source : project.target
    return side.schema.origin?.language ?? null
  }
  return models.schema.origin?.language ?? null
}

export type ConversionsAvailability = { ok: true } | { ok: false; reason: 'language'; models: string; project: LanguageId }

/** Whether conversions can be written for a project: the models are in its language, or in none. */
export function conversionsAvailable(models: ApplicationModels, language: LanguageId): ConversionsAvailability {
  const written = modelsLanguage(models, models.project?.root.split('->')[0])
  if (written === null || written === language) return { ok: true }
  return { ok: false, reason: 'language', models: written, project: language }
}

const path = (dotted: string): ModelPath => dotted.split('.')
const todo = (reason: TodoReason, detail?: string): Todo => ({ kind: 'todo', reason, ...(detail ? { detail } : {}) })
const WRITTEN = new Set<MapperTransform['kind']>(['direct', 'concat', 'split', 'constant', 'boolean', 'enum', 'epoch', 'arithmetic'])

function mapperField(project: MapperProject | null | undefined, mapping: string, target: string): MapperField | undefined {
  return project?.mappings.find((item) => item.id === mapping)?.fields.find((field) => field.target === target)
}

/** The columns the fields of the table's side of a Mapper relation name. */
function columnsOf(paths: string[][], table: DbTable, tableFields: FieldDef[]): string[] | null {
  const columns: string[] = []
  for (const item of paths) {
    const field = tableFields.find((candidate) => candidate.name === item[0])
    const column = field && item.length === 1 ? table.columns.find((candidate) => fieldFor(candidate, [field], new Set())) : undefined
    if (!column) return null
    columns.push(column.name)
  }
  return columns
}

function tableFieldsOf(project: MapperProject, mapping: string, side: 'source' | 'target'): FieldDef[] {
  const found = project.mappings.find((item) => item.id === mapping)
  const schema = project[side].schema
  const model = found && schema.models.find((item) => item.name === (side === 'source' ? found.source : found.target))
  return model ? fieldsOf(model, schema) : []
}

// Nested documents

interface Scope {
  /** Whether nested documents are converted */
  documents: boolean
  models: ModelSchema
  database: DbSchema
}

/** A field and a column that hold documents: their shapes, or null when they cannot be converted; undefined when neither
 * holds any. A list is converted to a list, a document to a document. */
function documentsOf(
  type: TypeRef,
  column: DbType,
  scope: Scope,
): { model: string; many: boolean; columns: DbColumn[]; fields: FieldDef[] } | null | undefined {
  if (!scope.documents) return undefined
  const columns = nestedFields(column)
  const inside = modelOf(type)
  // A JSON column of a relational database says nothing of its documents: its value goes as it is
  if (!columns && !(inside && scope.database.dialect === 'mongodb')) return undefined
  const many = type.kind === 'array'
  const item = type.kind === 'array' ? type.items : type
  const kept = column.kind === 'array' ? column.items : column
  const model = item.kind === 'model' ? scope.models.models.find((candidate) => candidate.name === item.name) : undefined
  if (!model || !columns || many !== (column.kind === 'array') || kept.kind !== 'json') return null
  return { model: model.name, many, columns, fields: fieldsOf(model, scope.models) }
}

/** The fields of a document with the field of the model each one is. */
function paired(columns: DbColumn[], fields: FieldDef[]): { column: DbColumn; field: FieldDef | null }[] {
  const taken = new Set<string>()
  return columns.map((column) => {
    const found = fieldFor(column, fields, taken)
    if (found) taken.add(found.field.name)
    return { column, field: found?.field ?? null }
  })
}

const differs = (field: FieldDef, column: DbColumn) => todo('unsupported', `${field.name}: ${column.type.sql}`)

function writeNested(path: ModelPath, type: TypeRef, column: DbType, scope: Scope): WriteValue {
  const documents = documentsOf(type, column, scope)
  if (documents === undefined) return { kind: 'field', path }
  if (documents === null) return todo('unsupported', path.join('.'))
  const pairs = paired(documents.columns, documents.fields)
  const values = pairs.flatMap(({ column: inner, field }) => {
    const needed = !inner.nullable && inner.default === undefined && !inner.generated
    if (!field) return needed ? [{ column: inner.name, value: todo('noField', inner.name) }] : []
    if (!compatible(field.type, inner, scope.models, scope.database)) return [{ column: inner.name, value: differs(field, inner) }]
    return [{ column: inner.name, value: writeNested([field.name], field.type, inner.type, scope) }]
  })
  const unused = documents.fields
    .filter((field) => !field.generated && !pairs.some((item) => item.field === field))
    .map((field) => field.name)
  return { kind: 'document', path, model: documents.model, many: documents.many, values, unused }
}

function readNested(column: DbColumn, field: FieldDef, scope: Scope): ReadValue {
  const documents = documentsOf(field.type, column.type, scope)
  if (documents === undefined) return { kind: 'column', column: column.name }
  if (documents === null) return todo('unsupported', field.name)
  const pairs = paired(documents.columns, documents.fields)
  const values = documents.fields.flatMap((inner): { field: string; value: ReadValue }[] => {
    const found = pairs.find((item) => item.field === inner)
    if (!found) return inner.optional || inner.nullable ? [] : [{ field: inner.name, value: todo('noField', inner.name) }]
    if (!compatible(inner.type, found.column, scope.models, scope.database))
      return [{ field: inner.name, value: differs(inner, found.column) }]
    return [{ field: inner.name, value: readNested(found.column, inner, scope) }]
  })
  return { kind: 'document', column: column.name, model: documents.model, many: documents.many, values }
}

function writeValue(column: ColumnMatch, table: DbTable, models: ApplicationModels, fields: FieldDef[], scope: Scope): WriteValue | null {
  const { source } = column
  const value = source.value
  if (value === null) return source.confidence === 'conflict' ? todo('noField') : null
  // The table is Mapper's source: writing needs the inverse of the relation
  if (value.kind === 'mapper' && value.side === 'source' && !value.inverse) return todo('oneWay', value.fields.join(', '))
  if (waits(column) && !(value.kind === 'mapper' && value.side === 'target' && oneWay(column)))
    return todo('pending', value.kind !== 'database' ? describe(value) : undefined)
  if (value.kind === 'database') return null
  if (value.kind === 'field') {
    const field = fields.find((item) => item.name === value.field)
    const kept = table.columns.find((item) => item.name === column.column)
    return field && kept ? writeNested([field.name], field.type, kept.type, scope) : { kind: 'field', path: path(value.field) }
  }
  if (value.kind === 'lookup') {
    const key = table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === column.column)
    return { kind: 'lookup', path: path(value.field), table: value.table, by: value.by, key: key?.references.columns[0] ?? 'id' }
  }
  const field = mapperField(models.project, value.mapping, value.target)
  if (!field) return todo('unsupported', value.fields.join(', '))
  if (value.side === 'target') {
    if (!WRITTEN.has(field.transform.kind)) return todo('unsupported', transformDetail(field.transform))
    return { kind: 'mapper', transform: field.transform, sources: field.sources }
  }
  return { kind: 'inverse', transform: field.transform, path: [value.target] }
}

/** Whether a decision waits for the user. */
const waits = (column: ColumnMatch) => column.source.status === 'pending'

/** Whether it waits only because Mapper's relation serves one direction: that direction can be written. */
const oneWay = (column: ColumnMatch) => column.source.reasons.every((item) => item.code === 'mapperOneWay')

function describe(value: Exclude<ColumnMatch['source']['value'], null>): string {
  if (value.kind === 'mapper') return value.fields.join(', ')
  return value.kind === 'database' ? '' : value.field
}

function transformDetail(transform: MapperTransform): string {
  return transform.kind === 'expression' ? transform.expression : transform.kind
}

function readValue(field: FieldDef, columns: ColumnMatch[], table: DbTable, models: ApplicationModels, scope: Scope): ReadValue | null {
  for (const column of columns) {
    const value = column.source.value
    if (!value || value.kind === 'database') continue
    // A one-way Mapper relation waits only for the direction it does not serve
    const pending = waits(column) && !(value.kind === 'mapper' && value.side === 'source' && oneWay(column))
    if (value.kind === 'field' && value.field === field.name) {
      if (pending) return todo('pending', field.name)
      const kept = table.columns.find((item) => item.name === column.column)
      return kept ? readNested(kept, field, scope) : { kind: 'column', column: column.column }
    }
    if (value.kind === 'lookup' && value.field === field.name) {
      if (pending) return todo('pending', field.name)
      const key = table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === column.column)
      return { kind: 'lookup', column: column.column, table: value.table, by: value.by, key: key?.references.columns[0] ?? 'id' }
    }
    if (value.kind !== 'mapper') continue
    const mapped = mapperField(models.project, value.mapping, value.target)
    if (value.side === 'source' && value.target === field.name) {
      if (pending) return todo('pending', field.name)
      if (!mapped || !WRITTEN.has(mapped.transform.kind))
        return todo('unsupported', mapped ? transformDetail(mapped.transform) : field.name)
      const named = columnsOf(mapped.sources, table, tableFieldsOf(models.project!, value.mapping, 'source'))
      return named ? { kind: 'mapper', transform: mapped.transform, columns: named } : todo('unsupported', field.name)
    }
    if (value.side === 'target' && value.fields.includes(field.name)) {
      // Reading needs the inverse of the relation, which only a lossless one of a single field has
      if (!value.inverse || value.fields.length > 1 || !mapped) return todo('oneWay', value.fields.join(', '))
      if (pending) return todo('pending', field.name)
      return { kind: 'inverse', transform: mapped.transform, column: column.column }
    }
  }
  return field.optional || field.nullable ? null : todo('noField', field.name)
}

/** Whether the database fills a column on insert: a write never sends it. */
function fills(table: DbTable, name: string): boolean {
  const generated = table.columns.find((column) => column.name === name)?.generated
  return generated !== undefined && generated !== 'onUpdateNow'
}

/** A list field read from a join table: the keys of the other table its rows link this row with. */
function childrenValue(child: ChildrenMatch, table: DbTable, schema: DbSchema): ReadValue | null {
  const name = child.table.value
  if (name === null) return null
  if (child.table.status === 'pending') return todo('pending', child.field)
  const other = schema.tables.find((item) => item.name === name)
  const here = other?.foreignKeys.find((item) => item.references.table === table.name && item.columns.length === 1)
  const there = other?.foreignKeys.find((item) => item !== here && item.columns.length === 1)
  if (!other || !here || !there) return todo('unsupported', child.field)
  return { kind: 'children', table: other.name, by: here.columns[0], key: here.references.columns[0], value: there.columns[0] }
}

/**
 * The conversions of every table whose model the matching settled; with `documents`, also what is inside nested
 * documents, which only strategies of document databases write.
 */
export function planConversions(schema: DbSchema, design: CrudDesign, models: ApplicationModels, documents = false): ConversionPlan[] {
  const plans: ConversionPlan[] = []
  for (const tableMatch of design.matching?.tables ?? []) {
    const table = schema.tables.find((item) => item.name === tableMatch.table)
    if (!table) continue
    for (const match of tableMatch.models) {
      const name = match.model.value
      const model = name === null ? undefined : models.schema.models.find((item) => item.name === name)
      if (!model || match.model.status === 'pending') continue
      const fields = fieldsOf(model, models.schema)
      const scope: Scope = { models: models.schema, database: schema, documents }
      const writes = match.direction !== 'output'
      const reads = match.direction !== 'input'
      const write = writes
        ? match.columns.flatMap((column) => {
            // What the database fills is never written (a key it numbers, a computed column, a creation time)
            if (fills(table, column.column)) return []
            const value = writeValue(column, table, models, fields, scope)
            return value ? [{ column: column.column, value }] : []
          })
        : null
      const read = reads
        ? fields.flatMap((field) => {
            const child = match.children.find((item) => item.field === field.name)
            const value = child ? childrenValue(child, table, schema) : readValue(field, match.columns, table, models, scope)
            return value ? [{ field: field.name, value }] : []
          })
        : null
      plans.push({ table: table.name, model: model.name, direction: match.direction, write, read })
    }
  }
  return plans
}
