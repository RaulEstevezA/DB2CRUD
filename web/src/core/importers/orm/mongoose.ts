/**
 * Reads Mongoose schemas into the physical schema: every model is a collection, with the fields of its schema
 * (types, `required`, defaults, `enum` and limits, references), its nested documents and arrays, the indexes of the
 * fields and of `schema.index(…)`, and `timestamps`. A schema only used inside others is a nested document. A
 * reference to one document of a collection the code declares is read as a foreign key, which MongoDB does not check.
 */
import { pluralize } from '../../model/naming.ts'
import { checkOf } from '../../schema/checks.ts'
import { idColumn, isObjectId, OBJECT_ID } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbForeignKey, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, stringOf, textOf, type Expr } from './expressions.ts'
import type { OrmReader, SourceFile } from './types.ts'
import { SYNTAX } from './typescript.ts'

interface SchemaCall {
  fields: Expr | undefined
  options: Map<string, Expr>
  indexes: { fields: Expr | undefined; options: Map<string, Expr> }[]
  line: number
}

interface ModelCall {
  name: string
  /** The variable of its schema */
  schema: string
  collection?: string
  line: number
}

function entriesOf(expr: Expr | undefined): Map<string, Expr> {
  const entries = new Map<string, Expr>()
  if (expr?.kind === 'dict')
    for (const entry of expr.entries) {
      const key = nameOf(entry.key) ?? stringOf(entry.key)
      if (key) entries.set(key, entry.value)
    }
  return entries
}

/** After a name, the `<…>` of its type arguments, when it has them. */
function skipTypeArguments(tokens: Token[], index: number): number {
  if (tokens[index]?.value !== '<') return index
  let depth = 0
  for (let at = index; at < tokens.length; at++) {
    if (tokens[at].value === '<') depth++
    else if (tokens[at].value === '>') {
      depth--
      if (depth === 0) return at + 1
    } else if (tokens[at].value === ';') return index
  }
  return index
}

function readCalls(files: SourceFile[]) {
  const schemas = new Map<string, SchemaCall>()
  const models: ModelCall[] = []
  const indexes: { schema: string; args: Expr[] }[] = []
  let inline = 0
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, TYPESCRIPT_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    const argumentsAt = (index: number) => {
      cursor.index = index
      return readArguments(cursor, file.text, SYNTAX, ')').args
    }
    /** The index after the `(` of a call to `name` or to something`.name`, when the token starts one. */
    const callOf = (index: number, name: string): number | undefined => {
      if (tokens[index]?.value !== name || tokens[index].kind !== 'ident') return undefined
      const open = skipTypeArguments(tokens, index + 1)
      return tokens[open]?.value === '(' ? open + 1 : undefined
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      const schemaAt = callOf(index, 'Schema')
      if (schemaAt !== undefined) {
        const start = tokens[index - 1]?.value === '.' ? index - 2 : index
        if (tokens[start - 1]?.value !== 'new') continue
        // `const orderSchema: Schema<Order> = new Schema(…)`, or a schema written where it is used
        let variable: string | undefined
        if (tokens[start - 2]?.value === '=') {
          let at = start - 3
          while (at > 0 && !['const', 'let', 'var'].includes(tokens[at].value) && tokens[at].value !== ';') at--
          if (['const', 'let', 'var'].includes(tokens[at].value)) variable = tokens[at + 1]?.value
        }
        const args = argumentsAt(schemaAt)
        if (args[0]?.kind !== 'dict') continue
        if (variable) schemas.set(variable, { fields: args[0], options: entriesOf(args[1]), indexes: [], line: token.line })
        continue
      }
      const modelAt = callOf(index, 'model')
      if (modelAt !== undefined) {
        const args = argumentsAt(modelAt)
        const name = stringOf(args[0])
        if (!name || !args[1]) continue
        let schema = args[1].kind === 'name' ? nameOf(args[1]) : undefined
        // `model('Tag', new Schema({ … }))`: the schema has no variable
        if (args[1].kind === 'call' && nameOf(args[1]) === 'Schema') {
          schema = `#${inline++}`
          schemas.set(schema, { fields: args[1].args[0], options: entriesOf(args[1].args[1]), indexes: [], line: token.line })
        }
        if (schema) models.push({ name, schema, collection: stringOf(args[2]), line: token.line })
        continue
      }
      if (
        token.value === 'index' &&
        tokens[index - 1]?.value === '.' &&
        tokens[index + 1]?.value === '(' &&
        tokens[index - 2]?.kind === 'ident'
      )
        indexes.push({ schema: tokens[index - 2].value, args: argumentsAt(index + 2) })
    }
  }
  for (const item of indexes) schemas.get(item.schema)?.indexes.push({ fields: item.args[0], options: entriesOf(item.args[1]) })
  return { schemas, models }
}

const TYPES: Record<string, DbType> = {
  String: { sql: 'String', kind: 'text' },
  Number: { sql: 'Number', kind: 'float', bits: 64 },
  Double: { sql: 'Double', kind: 'float', bits: 64 },
  Int32: { sql: 'Int32', kind: 'integer', bits: 32 },
  BigInt: { sql: 'BigInt', kind: 'integer', bits: 64 },
  Boolean: { sql: 'Boolean', kind: 'boolean' },
  Date: { sql: 'Date', kind: 'datetime', timezone: true },
  Decimal128: { sql: 'Decimal128', kind: 'decimal' },
  UUID: { sql: 'UUID', kind: 'uuid' },
  Buffer: { sql: 'Buffer', kind: 'binary' },
  ObjectId: OBJECT_ID,
  Map: { sql: 'Map', kind: 'json' },
  Mixed: { sql: 'Mixed', kind: 'json' },
  Object: { sql: 'Mixed', kind: 'json' },
}

/** The names a type may be written as: `'string'`, `Schema.Types.ObjectID`, `Bool`. */
const ALIASES: Record<string, string> = { ObjectID: 'ObjectId', Oid: 'ObjectId', Bool: 'Boolean', Long: 'BigInt', Schema: '' }

function typeNamed(name: string | undefined): DbType | undefined {
  if (!name) return undefined
  const plain = ALIASES[name] ?? name
  return TYPES[plain] ?? TYPES[plain.charAt(0).toUpperCase() + plain.slice(1)]
}

/** A setting of a field, without the message it may carry: `[true, 'Why?']`. */
const setting = (expr: Expr | undefined): Expr | undefined => (expr?.kind === 'list' ? expr.items[0] : expr)

interface Reading {
  schemas: Map<string, SchemaCall>
  enums: DbEnum[]
  notes: DbNote[]
  /** The schemas being read, so one that nests itself ends */
  path: string[]
}

interface FieldRead {
  column: DbColumn
  checks: DbCheck[]
  ref?: string
  unique: boolean
  index: boolean
}

/** Whether an object literal is the settings of a field: it has a `type` that is not a field called so. */
function isSettings(expr: Expr): boolean {
  const type = entriesOf(expr).get('type')
  return type !== undefined && !(type.kind === 'dict' && entriesOf(type).has('type'))
}

/** The type of a field: a name, a schema, an array of one, or a nested document; `ref` when it points to a model. */
function typeOf(expr: Expr, where: string, reading: Reading): { type: DbType; ref?: string } | null {
  if (expr.kind === 'list') {
    if (expr.items.length === 0) return { type: { sql: '[]', kind: 'array', items: TYPES.Mixed } }
    const settings = expr.items[0].kind === 'dict' && isSettings(expr.items[0]) ? entriesOf(expr.items[0]) : undefined
    const item = typeOf(settings?.get('type') ?? expr.items[0], where, reading)
    if (!item) return null
    const values = settings ? enumValues(settings.get('enum')) : null
    // A document written in a list has an identifier too
    if (
      !settings &&
      expr.items[0].kind === 'dict' &&
      item.type.kind === 'json' &&
      item.type.fields &&
      !item.type.fields.some((field) => field.name === '_id')
    )
      item.type = { ...item.type, fields: [{ ...idColumn(), nullable: true }, ...item.type.fields] }
    const items: DbType = values ? enumType(where, values, reading) : item.type
    return { type: { sql: `[${items.sql}]`, kind: 'array', items } }
  }
  if (expr.kind === 'dict') {
    if (expr.entries.length === 0) return { type: TYPES.Mixed }
    return { type: { sql: 'Object', kind: 'json', fields: fieldsOf(expr, where, reading).map((field) => field.column) } }
  }
  if (expr.kind === 'call' && nameOf(expr) === 'Schema')
    return { type: nested({ fields: expr.args[0], options: entriesOf(expr.args[1]), indexes: [], line: 0 }, where, reading) }
  const name = expr.kind === 'string' ? expr.value : nameOf(expr)
  const schema = name ? reading.schemas.get(name) : undefined
  if (schema && name) {
    if (reading.path.includes(name)) return { type: TYPES.Mixed }
    return { type: nested(schema, where, { ...reading, path: [...reading.path, name] }) }
  }
  const type = typeNamed(name)
  return type ? { type } : null
}

/** A nested document: Mongoose gives it an `_id` of its own unless it is told not to. */
function nested(schema: SchemaCall, where: string, reading: Reading): DbType {
  const fields = fieldsOf(schema.fields, where, reading).map((field) => field.column)
  if (booleanOf(schema.options.get('_id')) !== false && !fields.some((field) => field.name === '_id'))
    fields.unshift({ ...idColumn(), nullable: true })
  return { sql: 'Object', kind: 'json', fields }
}

function enumValues(expr: Expr | undefined): (string | number)[] | null {
  const list = expr?.kind === 'dict' ? entriesOf(expr).get('values') : expr
  if (list?.kind !== 'list') return null
  const values = list.items
    .map((item) => literalOf(item))
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
  return values.length > 0 ? values : null
}

function enumType(where: string, values: (string | number)[], reading: Reading): DbType {
  const name = where.replace(/\W+/g, '_')
  if (!reading.enums.some((item) => item.name === name)) reading.enums.push({ name, values: values.map(String), storage: 'check' })
  return { sql: 'String', kind: 'enum', name }
}

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

/** The fields of a schema or of a nested document. `where` is the path of the field, for the notes and the enums. */
function fieldsOf(expr: Expr | undefined, where: string, reading: Reading): FieldRead[] {
  const nestedField = where.includes('.')
  const result: FieldRead[] = []
  for (const [name, value] of entriesOf(expr)) {
    const path = `${where}.${name}`
    const settings = value.kind === 'dict' && isSettings(value) ? entriesOf(value) : new Map<string, Expr>()
    const read = typeOf(settings.get('type') ?? value, path, reading)
    if (!read)
      reading.notes.push({
        code: 'orm.unknownType',
        params: { table: where.split('.')[0], column: path.slice(path.indexOf('.') + 1), type: textOf(value) },
      })
    const column: DbColumn = {
      name,
      type: read?.type ?? { sql: textOf(value), kind: 'unknown' },
      nullable: booleanOf(setting(settings.get('required'))) !== true && name !== '_id',
    }
    const checks: DbCheck[] = []
    const values = enumValues(settings.get('enum'))
    if (values && column.type.kind === 'text' && !nestedField) checks.push(checkOf(`${name} IN (${quoted(values)})`))
    else if (values && column.type.kind === 'text') column.type = enumType(path, values, reading)
    else if (values && !nestedField) checks.push(checkOf(`${name} IN (${quoted(values)})`))
    const limit = (key: string) => numberOf(setting(settings.get(key)))
    if (column.type.kind === 'text' && limit('maxlength') !== undefined) column.type = { ...column.type, length: limit('maxlength') }
    if (!nestedField) {
      if (limit('min') !== undefined && column.type.kind !== 'datetime') checks.push(checkOf(`${name} >= ${limit('min')}`))
      if (limit('max') !== undefined && column.type.kind !== 'datetime') checks.push(checkOf(`${name} <= ${limit('max')}`))
      if (limit('minlength') !== undefined) checks.push(checkOf(`LENGTH(${name}) >= ${limit('minlength')}`))
    }
    const initial = settings.get('default')
    if (initial?.kind === 'name' && initial.path.join('.') === 'Date.now') column.generated = 'now'
    else if (initial?.kind === 'other' && /Date\.now\(\)|new Date\(\)/.test(initial.text)) column.generated = 'now'
    else if (initial?.kind === 'other' && /randomUUID\(\)|new (\w+\.)*UUID\(\)/.test(initial.text)) column.generated = 'uuid'
    else if (initial) {
      const literal = literalOf(initial)
      if (literal !== undefined && literal !== null) column.default = { kind: 'literal', value: literal }
    }
    const ref =
      read?.ref ?? stringOf(settings.get('ref')) ?? (settings.get('ref')?.kind === 'name' ? nameOf(settings.get('ref')) : undefined)
    result.push({
      column,
      checks,
      ...(ref && column.type.kind !== 'array' ? { ref } : {}),
      unique: booleanOf(setting(settings.get('unique'))) === true,
      index: booleanOf(settings.get('index')) === true,
    })
  }
  return result
}

/** The names of the two dates `timestamps` adds: their own, or those the options give. */
function timestampsOf(expr: Expr | undefined): { created?: string; updated?: string } {
  if (booleanOf(expr) === true) return { created: 'createdAt', updated: 'updatedAt' }
  if (expr?.kind !== 'dict') return {}
  const entries = entriesOf(expr)
  const name = (key: string) => (booleanOf(entries.get(key)) === false ? undefined : (stringOf(entries.get(key)) ?? key))
  return { created: name('createdAt'), updated: name('updatedAt') }
}

function readMongoose(files: SourceFile[]): DbSchema {
  const { schemas, models } = readCalls(files)
  const enums: DbEnum[] = []
  const notes: DbNote[] = []
  const tables: DbTable[] = []
  const pending: { table: DbTable; column: string; model: string }[] = []
  const byModel = new Map<string, DbTable>()
  for (const model of models) {
    const schema = schemas.get(model.schema)
    if (!schema || byModel.has(model.name)) continue
    const name = model.collection ?? stringOf(schema.options.get('collection')) ?? pluralize(model.name.toLowerCase())
    const table: DbTable = {
      name,
      columns: [],
      primaryKey: ['_id'],
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: model.name,
      origin: { line: model.line, column: 1 },
    }
    const fields = fieldsOf(schema.fields, name, { schemas, enums, notes, path: [model.schema] })
    for (const field of fields) {
      table.columns.push(field.column)
      table.checks.push(...field.checks)
      if (field.ref) pending.push({ table, column: field.column.name, model: field.ref })
      if (field.unique && field.column.name !== '_id') table.uniques.push({ columns: [field.column.name] })
      else if (field.index && field.column.type.kind !== 'array') table.indexes.push({ columns: [field.column.name] })
    }
    const id = table.columns.find((column) => column.name === '_id')
    if (!id) table.columns.unshift(idColumn())
    else if (isObjectId(id.type)) id.generated = 'uuid'
    const { created, updated } = timestampsOf(schema.options.get('timestamps'))
    const date = (column: string, generated: 'now' | 'onUpdateNow') => {
      const existing = table.columns.find((item) => item.name === column)
      if (existing) existing.generated = generated
      else table.columns.push({ name: column, type: TYPES.Date, nullable: true, generated })
    }
    if (created) date(created, 'now')
    if (updated) date(updated, 'onUpdateNow')
    for (const index of schema.indexes)
      addIndex(
        table,
        [...entriesOf(index.fields).keys()],
        booleanOf(index.options.get('unique')) === true,
        stringOf(index.options.get('name')),
        notes,
      )
    tables.push(table)
    byModel.set(model.name, table)
  }
  for (const item of pending) {
    const target = byModel.get(item.model)
    if (!target) {
      notes.push({ code: 'orm.unknownReference', params: { table: item.table.name, column: item.column } })
      continue
    }
    const key: DbForeignKey = { columns: [item.column], references: { table: target.name, columns: ['_id'] } }
    item.table.foreignKeys.push(key)
  }
  return { format: 'db-schema', version: 1, dialect: 'mongodb', source: { kind: 'orm', format: 'mongoose' }, tables, enums, notes }
}

/** Adds an index of whole fields; one inside documents or over a list is the database's own business. */
export function addIndex(table: DbTable, columns: string[], unique: boolean, name: string | undefined, notes: DbNote[]): void {
  const known = columns.every((column) => {
    const type = table.columns.find((item) => item.name === column)?.type.kind
    return type !== undefined && type !== 'array' && type !== 'json'
  })
  if (columns.length === 0 || (columns.length === 1 && columns[0] === '_id')) return
  if (!known) {
    notes.push({ code: 'orm.unreadIndex', params: { table: table.name, index: columns.join(', ') } })
    return
  }
  const list = unique ? table.uniques : table.indexes
  if (!list.some((item) => item.columns.join() === columns.join())) list.push({ ...(name ? { name } : {}), columns })
}

export const mongooseReader: OrmReader = {
  id: 'mongoose',
  label: 'Mongoose',
  language: 'typescript',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    if (!/\bnew\s+(\w+\.)?Schema\s*(<[^(]*>)?\s*\(/.test(text)) return 0
    return /['"]mongoose['"]/.test(text) ? 1 : /\bmodel\s*(<[^(]*>)?\s*\(/.test(text) ? 0.7 : 0
  },
  read: readMongoose,
}
