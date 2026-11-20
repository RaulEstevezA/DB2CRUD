/**
 * Matching application models with the tables of the database (docs/design.md, section 2): each table gets the
 * model it corresponds to, and each column the field it comes from, every proposal with its confidence and its
 * reasons. Where a model and a column disagree (a longer text, an optional field for a required column, another
 * type, enum values the column refuses), the conflict is shown and never resolved on its own.
 *
 * The rules compare names by their words, whatever their convention (`customerId`, `customer_id`), with plurals and
 * the usual suffixes of models (`Entity`, `Dto`, `Request`…) left out. A field may also come from another table: a
 * lookup (`categoryName` → the `name` of the category `category_id` points to) or the rows of a child table
 * (`tagIds` → the rows of `product_tags`).
 */
import { readConstraints } from '../analysis/constraints.ts'
import { decision, reason, type Decision, type Reason } from '../decisions/decision.ts'
import { nameWords, singularize } from '../model/naming.ts'
import type { FieldDef, ModelDef, ModelSchema, TypeRef } from '../model/schema.ts'
import type { DbColumn, DbSchema, DbTable } from '../schema/types.ts'

export type ColumnSource =
  | { kind: 'field'; field: string }
  /** The column is the key of the row of `table` whose `by` column has the field's value */
  | { kind: 'lookup'; field: string; table: string; by: string }
  /** The database fills it: the model does not send it */
  | { kind: 'database' }

export type Conflict =
  | { kind: 'length'; model: number; column: number }
  | { kind: 'nullable' }
  | { kind: 'type'; model: string; column: string }
  | { kind: 'values'; missing: string[] }

export interface ColumnMatch {
  column: string
  source: Decision<ColumnSource | null>
  /** Where the model and the column disagree: shown, never resolved on their own */
  conflicts: Conflict[]
}

/** A field that is a list of the rows of another table: `tagIds` → the rows of `product_tags`. */
export interface ChildrenMatch {
  field: string
  table: Decision<string | null>
}

export interface TableMatch {
  table: string
  model: Decision<string | null>
  columns: ColumnMatch[]
  children: ChildrenMatch[]
  /** Fields of the model no column or child table takes: they are not saved */
  unused: string[]
}

export interface Matching {
  tables: TableMatch[]
}

// Names

const MODEL_SUFFIXES = new Set(['entity', 'model', 'dto', 'record', 'request', 'response'])

/** The words a model name is compared by: without its suffixes, the last one singular. */
function modelWords(name: string): string[] {
  const words = nameWords(name)
  while (words.length > 1 && MODEL_SUFFIXES.has(words.at(-1)!)) words.pop()
  return singularWords(words)
}

const singularWords = (words: string[]) => (words.length > 0 ? [...words.slice(0, -1), singularize(words.at(-1)!)] : words)
const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((word, index) => word === b[index])
const key = (words: string[]) => words.join(' ')

// Types

/** The column kinds a model type can be kept in. */
const COMPATIBLE: Record<string, string[]> = {
  // Exact decimals often travel as text
  string: ['text', 'uuid', 'enum', 'date', 'time', 'datetime', 'decimal', 'json', 'unknown'],
  integer: ['integer', 'decimal', 'boolean', 'unknown'],
  float: ['float', 'decimal', 'unknown'],
  decimal: ['decimal', 'float', 'text', 'unknown'],
  boolean: ['boolean', 'integer', 'unknown'],
  date: ['date', 'datetime', 'text', 'unknown'],
  datetime: ['datetime', 'text', 'integer', 'unknown'],
  time: ['time', 'text', 'unknown'],
  duration: ['integer', 'text', 'unknown'],
  uuid: ['uuid', 'text', 'binary', 'unknown'],
  binary: ['binary', 'unknown'],
  any: ['json', 'text', 'unknown'],
}

function typeName(type: TypeRef): string {
  if (type.kind === 'primitive') return type.name
  if (type.kind === 'array') return `${typeName(type.items)}[]`
  if (type.kind === 'map') return 'map'
  return type.name
}

/** Languages with one type for every number (`number`): a whole number is one of its values. */
const ONE_NUMBER = new Set(['typescript', 'javascript'])

/** Whether a column can keep the values of a field's type. */
function compatible(type: TypeRef, column: DbColumn, schema: ModelSchema): boolean {
  const kind = column.type.kind
  if (type.kind === 'primitive' && type.name === 'float' && kind === 'integer' && ONE_NUMBER.has(schema.origin?.language ?? '')) return true
  if (type.kind === 'primitive') return COMPATIBLE[type.name]?.includes(kind) ?? true
  if (type.kind === 'array') return kind === 'array' || kind === 'json' || kind === 'unknown'
  if (type.kind === 'map' || type.kind === 'model') return kind === 'json' || kind === 'unknown'
  if (type.kind === 'enum') {
    const values = schema.enums.find((item) => item.name === type.name)?.values ?? []
    const numeric = values.length > 0 && values.every((value) => typeof value.value === 'number')
    return numeric ? kind === 'integer' || kind === 'unknown' : ['enum', 'text', 'unknown'].includes(kind)
  }
  return true
}

/** The values a column accepts: those of its enum type, or of a CHECK `IN` on it. */
function acceptedValues(column: DbColumn, table: DbTable, database: DbSchema): string[] | null {
  if (column.type.kind === 'enum') {
    const name = column.type.name
    const found = database.enums.find((item) => item.name === name)
    if (found) return found.values
  }
  for (const check of table.checks)
    if (check.parsed?.kind === 'in' && check.parsed.column === column.name) return check.parsed.values.map(String)
  return null
}

/** The values a field of an enum type sends. */
function fieldValues(type: TypeRef, schema: ModelSchema): string[] | null {
  if (type.kind !== 'enum') return null
  const found = schema.enums.find((item) => item.name === type.name)
  return found ? found.values.map((value) => String(value.value ?? value.name)) : null
}

/** Where the field and the column disagree. */
function conflictsOf(field: FieldDef, column: DbColumn, table: DbTable, database: DbSchema, schema: ModelSchema): Conflict[] {
  const conflicts: Conflict[] = []
  const declared = readConstraints(field, schema.origin?.language).constraints
  if (
    column.type.kind === 'text' &&
    column.type.length !== undefined &&
    declared.maxLength !== undefined &&
    declared.maxLength > column.type.length
  )
    conflicts.push({ kind: 'length', model: declared.maxLength, column: column.type.length })
  const required = !column.nullable && !column.default && !column.generated
  if (required && (field.optional || field.nullable)) conflicts.push({ kind: 'nullable' })
  if (!compatible(field.type, column, schema)) conflicts.push({ kind: 'type', model: typeName(field.type), column: column.type.kind })
  const sent = fieldValues(field.type, schema)
  const accepted = acceptedValues(column, table, database)
  if (sent && accepted) {
    // A value that differs only in case is converted on the way: only one the column does not have is a conflict
    const lower = accepted.map((value) => value.toLowerCase())
    const missing = sent.filter((value) => !lower.includes(value.toLowerCase()))
    if (missing.length > 0) conflicts.push({ kind: 'values', missing })
  }
  return conflicts
}

// Rules

/** All fields of a model, with those of the models it extends first. */
function fieldsOf(model: ModelDef, schema: ModelSchema, seen = new Set<string>()): FieldDef[] {
  seen.add(model.name)
  const inherited = (model.extends ?? []).flatMap((name) => {
    const parent = schema.models.find((item) => item.name === name)
    return parent && !seen.has(parent.name) ? fieldsOf(parent, schema, seen) : []
  })
  return [...inherited, ...model.fields]
}

/** The model of a table: the one whose name, without its suffixes and plural, is the table's or its entity's. */
function matchModel(table: DbTable, schema: ModelSchema): Decision<string | null> {
  const targets = [table.name, ...(table.entity ? [table.entity] : [])].map((name) => key(singularWords(nameWords(name))))
  const found = schema.models.filter((model) => targets.includes(key(modelWords(model.name))))
  const options = [...found.map((model) => model.name), null]
  if (found.length === 1) return decision(found[0].name, 'exact', [reason('modelName', { model: found[0].name })], options)
  if (found.length > 1)
    return decision(found[0].name, 'review', [reason('modelNames', { models: found.map((model) => model.name).join(', ') })], options)
  return decision(null, 'none', [reason('noModel')], [...schema.models.map((model) => model.name), null])
}

/** The names a field answers to: its own, its name on the wire and its aliases. */
const fieldNames = (field: FieldDef) => [field.name, ...(field.serializedName ? [field.serializedName] : []), ...(field.aliases ?? [])]

/** The field a column comes from: the same name (exact), or the same words in another convention (probable). */
function fieldFor(column: DbColumn, fields: FieldDef[], taken: Set<string>): { field: FieldDef; confidence: 'exact' | 'probable' } | null {
  const names = [column.name, ...(column.attribute ? [column.attribute] : [])]
  const free = fields.filter((field) => !taken.has(field.name))
  const exact = free.find((field) => fieldNames(field).some((name) => names.includes(name)))
  if (exact) return { field: exact, confidence: 'exact' }
  const words = names.map((name) => key(nameWords(name)))
  const close = free.find((field) => fieldNames(field).some((name) => words.includes(key(nameWords(name)))))
  return close ? { field: close, confidence: 'probable' } : null
}

/** A lookup: a field `<x><Column>` (`categoryName`) for a foreign key `<x>_id` to a table with that column. */
function lookupFor(
  column: DbColumn,
  table: DbTable,
  fields: FieldDef[],
  taken: Set<string>,
  database: DbSchema,
): { field: FieldDef; table: DbTable; by: string; unique: boolean } | null {
  const key_ = table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === column.name)
  if (!key_) return null
  const target = database.tables.find((item) => item.name === key_.references.table)
  if (!target) return null
  // The words that name the parent: the column without its `id`, or the navigation name
  const columnWords = nameWords(column.name)
  const prefixes = [
    columnWords.at(-1) === 'id' ? columnWords.slice(0, -1) : columnWords,
    ...(key_.attribute ? [nameWords(key_.attribute)] : []),
    singularWords(nameWords(target.name)),
  ].filter((words) => words.length > 0)
  for (const field of fields) {
    if (taken.has(field.name) || field.type.kind === 'array') continue
    const words = nameWords(field.name)
    for (const prefix of prefixes) {
      if (!sameWords(words.slice(0, prefix.length), prefix) || words.length === prefix.length) continue
      const rest = words.slice(prefix.length)
      const by = target.columns.find((item) => sameWords(nameWords(item.name), rest))
      if (!by || key_.references.columns.includes(by.name)) continue
      const unique =
        target.uniques.some((item) => item.columns.length === 1 && item.columns[0] === by.name) ||
        (target.primaryKey?.length === 1 && target.primaryKey[0] === by.name)
      return { field, table: target, by: by.name, unique }
    }
  }
  return null
}

/** The child table a list field stands for: a join table to the field's table, or a table that points here. */
function childrenFor(field: FieldDef, table: DbTable, database: DbSchema): DbTable[] {
  if (field.type.kind !== 'array') return []
  const words = nameWords(field.name)
  // `tagIds`, `tags`, `tagList` → tag
  while (words.length > 1 && ['ids', 'id', 'list', 'set', 'keys'].includes(words.at(-1)!)) words.pop()
  const wanted = key(singularWords(words))
  const found: DbTable[] = []
  for (const other of database.tables) {
    const pointsHere = other.foreignKeys.filter((item) => item.references.table === table.name)
    if (other === table || pointsHere.length === 0) continue
    // A join table: its other foreign key names what the field lists
    const others = other.foreignKeys.filter((item) => item.references.table !== table.name)
    const names = [other.name, ...others.map((item) => item.references.table)]
    if (names.some((name) => key(singularWords(nameWords(name))) === wanted || key(singularWords(nameWords(name))).endsWith(` ${wanted}`)))
      found.push(other)
  }
  return found
}

function matchTable(table: DbTable, database: DbSchema, schema: ModelSchema): TableMatch {
  const model = matchModel(table, schema)
  const definition = schema.models.find((item) => item.name === model.value)
  const fields = definition ? fieldsOf(definition, schema) : []
  const taken = new Set<string>()
  const columns: ColumnMatch[] = []
  for (const column of table.columns) {
    const options: (ColumnSource | null)[] = [...fields.map((field): ColumnSource => ({ kind: 'field', field: field.name })), null]
    if (!definition) {
      columns.push({ column: column.name, source: decision(null, 'none', [], []), conflicts: [] })
      continue
    }
    const found = fieldFor(column, fields, taken)
    if (found) {
      taken.add(found.field.name)
      const conflicts = conflictsOf(found.field, column, table, database, schema)
      const confidence = conflicts.length > 0 ? 'conflict' : found.confidence
      const reasons: Reason[] = [reason(found.confidence === 'exact' ? 'fieldName' : 'fieldWords', { field: found.field.name })]
      columns.push({
        column: column.name,
        source: decision({ kind: 'field', field: found.field.name }, confidence, reasons, options),
        conflicts,
      })
      continue
    }
    const lookup = lookupFor(column, table, fields, taken, database)
    if (lookup) {
      taken.add(lookup.field.name)
      const source: ColumnSource = { kind: 'lookup', field: lookup.field.name, table: lookup.table.name, by: lookup.by }
      const reasons = [
        reason(lookup.unique ? 'lookupUnique' : 'lookupNotUnique', {
          field: lookup.field.name,
          table: lookup.table.name,
          column: lookup.by,
        }),
      ]
      columns.push({
        column: column.name,
        source: decision(source, lookup.unique ? 'probable' : 'review', reasons, [source, ...options]),
        conflicts: [],
      })
      continue
    }
    if (column.generated) {
      const source: ColumnSource = { kind: 'database' }
      columns.push({
        column: column.name,
        source: decision(source, 'exact', [reason('generatedColumn')], [source, ...options]),
        conflicts: [],
      })
      continue
    }
    // No field: the column keeps its default or null, unless it needs a value
    const required = !column.nullable && column.default === undefined
    columns.push({
      column: column.name,
      source: required
        ? decision(null, 'conflict', [reason('noFieldRequired')], options)
        : decision(null, 'none', [reason('noField')], options),
      conflicts: [],
    })
  }
  const children: ChildrenMatch[] = []
  for (const field of fields) {
    if (taken.has(field.name)) continue
    const found = childrenFor(field, table, database)
    if (found.length === 0) continue
    taken.add(field.name)
    const options = [...found.map((item) => item.name), null]
    children.push({
      field: field.name,
      table:
        found.length === 1
          ? decision(found[0].name, 'probable', [reason('childRows', { field: field.name, table: found[0].name })], options)
          : decision(
              found[0].name,
              'review',
              [reason('childTables', { field: field.name, tables: found.map((item) => item.name).join(', ') })],
              options,
            ),
    })
  }
  const unused = fields.filter((field) => !taken.has(field.name) && !field.generated).map((field) => field.name)
  return { table: table.name, model, columns, children, unused }
}

/** The matching of every table of the database with the application models. */
export function matchModels(database: DbSchema, schema: ModelSchema): Matching {
  return { tables: database.tables.map((table) => matchTable(table, database, schema)) }
}
