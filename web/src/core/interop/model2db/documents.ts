/**
 * The collections of a Model2DB project for MongoDB as `db-schema`. Their fields are those of the validators Model2DB
 * builds, read like any other validator (`importers/orm/mongodb.ts`); the design adds what a validator cannot say:
 * which fields point to another collection, and what each library stores in its own way.
 */
import { addIndex } from '../../importers/orm/mongoose.ts'
import { collectionsOf, type Reading } from '../../importers/orm/mongodb.ts'
import type { Expr } from '../../importers/orm/expressions.ts'
import { isObjectId, nestedFields, OBJECT_ID } from '../../schema/documents.ts'
import type { DbColumn, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { findModelDesign, type Design } from './vendor/design/types.ts'
import { buildDocumentView, type DocumentClass, type DocumentField, type DocumentView } from './vendor/generate/odm/documents.ts'
import { allFields, findModel, modelOf, type ModelSchema } from './vendor/model/schema.ts'
import { buildDocument, keyHolder } from './vendor/physical/document.ts'
import type { NamingOptions } from './vendor/physical/types.ts'

interface Library {
  /** Writes classes, which name the entities */
  classes: boolean
  /** Stores a UUID as MongoDB's own type, not as text */
  uuid: boolean
  /** Stores a reference as a DBRef, a document with the identifier inside */
  dbRef: boolean
  /** Stores the `id` of a nested document as `_id`, and one that is a text as an ObjectId, which it makes */
  springIds: boolean
}

const library = (settings: Partial<Library> = {}): Library => ({ classes: true, uuid: true, dbRef: false, springIds: false, ...settings })

/** The outputs of Model2DB for MongoDB (`generate/outputs.ts`). */
export const DOCUMENT_OUTPUTS: Record<string, Library> = {
  mongodb: library({ classes: false, uuid: false }),
  pymongo: library({ classes: false, uuid: false }),
  mongoose: library(),
  mongoengine: library({ uuid: false }),
  'spring-data-mongodb': library({ springIds: true }),
  beanie: library({ dbRef: true }),
}

/** A JSON value as the expression its text would be read as. */
function exprOf(value: unknown): Expr {
  if (typeof value === 'string') return { kind: 'string', value }
  if (typeof value === 'number') return { kind: 'number', value }
  if (Array.isArray(value)) return { kind: 'list', items: value.map(exprOf) }
  if (typeof value !== 'object' || value === null) return { kind: 'name', path: [String(value)] }
  return {
    kind: 'dict',
    entries: Object.entries(value).map(([key, item]) => ({ key: { kind: 'string', value: key }, value: exprOf(item) })),
  }
}

const UUID: DbType = { sql: 'UUID', kind: 'uuid' }

/** The type, or that of the items of a list, replaced. */
const replaced = (type: DbType, by: DbType): DbType =>
  type.kind === 'array' ? { sql: `array<${by.sql}>`, kind: 'array', items: replaced(type.items, by) } : by

const classOf = (view: DocumentView, name: string | undefined) => view.classes.find((item) => item.name === name)

/** The field whose value a field keeps: for a reference, the key of the model it points to. */
const keptField = (field: DocumentField, view: DocumentView) =>
  field.kind === 'reference' ? classOf(view, field.target)?.fields.find((item) => item.id) : field

function holds(field: DocumentField | undefined, primitive: 'uuid' | 'string'): boolean {
  if (!field) return false
  return (field.kind === 'value' || field.kind === 'values') && field.type.kind === 'primitive' && field.type.name === primitive
}

/** The fields of a class as the library stores them. */
function asStored(columns: DbColumn[], item: DocumentClass, view: DocumentView, stores: Library): void {
  for (const field of item.fields) {
    const column = columns.find((candidate) => candidate.name === field.stored)
    if (!column) continue
    const kept = keptField(field, view)
    // The identifier of its document, or of the one a reference points to
    const springId = stores.springIds && kept?.field.name === 'id' && (kept.id || !item.collection)
    if (field.kind === 'reference' && stores.dbRef) column.type = replaced(column.type, { sql: 'DBRef', kind: 'json' })
    else if (stores.uuid && holds(kept, 'uuid')) column.type = replaced(column.type, UUID)
    else if (springId && holds(kept, 'string')) column.type = replaced(column.type, OBJECT_ID)
    const nested = field.kind === 'embedded' ? classOf(view, field.target) : undefined
    const fields = nestedFields(column.type)
    if (nested && fields) asStored(fields, nested, view, stores)
    if (springId && field === kept) {
      column.name = '_id'
      if (isObjectId(column.type)) {
        column.generated = 'uuid'
        column.nullable = !item.collection
      }
    }
  }
}

/** The fields of the documents of a model that keep the identifier of a document of another collection. */
function references(model: string, item: DocumentClass, schema: ModelSchema, design: Design, naming: NamingOptions) {
  const found = findModel(schema, model)
  const decisions = findModelDesign(design, model)
  const result = item.fields
    .filter((field) => field.kind === 'reference' && !field.many)
    .map((field) => ({ column: field.stored, target: field.target! }))
  if (!found || !decisions) return result
  // `author` next to `authorId`: the identifier is in the second, and the first is not stored
  const fields = allFields(schema, found)
  for (const field of fields) {
    const decided = decisions.fields.find((candidate) => candidate.field === field.name)
    const target = field.type.kind === 'model' ? modelOf(field.type) : undefined
    if (!target || !decided?.include || decided.relation?.status !== 'active' || decided.relation.value !== 'reference') continue
    const column = keyHolder(field, fields, decisions, { naming })
    if (column && !result.some((reference) => reference.column === column)) result.push({ column, target })
  }
  return result
}

/** Both sides keep the same kind of value, so one can be looked up by the other. */
const sameValues = (left: DbType, right: DbType) => left.kind === right.kind && isObjectId(left) === isObjectId(right)

/** The collections Model2DB builds for this design with the output of the project. */
export function documentSchema(schema: ModelSchema, design: Design, naming: NamingOptions, output: string): DbSchema {
  const stores = DOCUMENT_OUTPUTS[output]
  const physical = buildDocument(schema, design, naming)
  const view = buildDocumentView(schema, design, physical, naming)
  const reading: Reading = { enums: [], notes: [] }
  const tables = collectionsOf(
    physical.collections.map((collection) => ({ name: collection.name, schema: exprOf(collection.validator) })),
    reading,
  )
  const notes: DbNote[] = physical.notes.map((note) => ({ code: `model2db.${note.code}`, params: note.params }))
  const byModel = new Map<string, DbTable>()
  physical.collections.forEach((collection, index) => {
    const table = tables[index]
    const item = classOf(view, collection.model)
    byModel.set(collection.model, table)
    if (stores.classes) table.entity = collection.model
    if (item) asStored(table.columns, item, view, stores)
    for (const entry of collection.indexes) addIndex(table, entry.columns, entry.unique, entry.name, reading.notes)
    for (const todo of collection.todos) notes.push({ code: `model2db.${todo.code}`, params: { ...todo.params, table: table.name } })
  })
  for (const [model, table] of byModel) {
    const item = classOf(view, model)
    if (!item) continue
    for (const { column, target } of references(model, item, schema, design, naming)) {
      const other = byModel.get(target)
      const from = table.columns.find((candidate) => candidate.name === column)
      const to = other?.columns.find((candidate) => candidate.name === '_id')
      if (other && from && to && sameValues(from.type, to.type))
        table.foreignKeys.push({ columns: [column], references: { table: other.name, columns: ['_id'] } })
    }
  }
  return {
    format: 'db-schema',
    version: 1,
    dialect: 'mongodb',
    source: { kind: 'model2db', format: output },
    tables,
    enums: reading.enums,
    notes: [...notes, ...reading.notes],
  }
}
