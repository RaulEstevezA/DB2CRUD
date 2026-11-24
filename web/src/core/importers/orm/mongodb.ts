/**
 * Reads the validators of MongoDB collections into the physical schema: a mongosh script
 * (`db.createCollection(…, { validator: { $jsonSchema } })` with its `createIndex`), or what
 * `db.getCollectionInfos()` prints. Each `$jsonSchema` gives the fields of a collection, with their types, what is
 * required, the values and limits of each and its nested documents.
 */
import { checkOf } from '../../schema/checks.ts'
import { idColumn, isObjectId, OBJECT_ID } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import { addIndex } from './mongoose.ts'
import type { OrmReader, SourceFile } from './types.ts'
import { SYNTAX } from './typescript.ts'

function entriesOf(expr: Expr | undefined): Map<string, Expr> {
  const entries = new Map<string, Expr>()
  if (expr?.kind === 'dict')
    for (const entry of expr.entries) {
      const key = nameOf(entry.key) ?? stringOf(entry.key)
      if (key) entries.set(key, entry.value)
    }
  return entries
}

const stringsOf = (expr: Expr | undefined): string[] =>
  expr?.kind === 'list' ? expr.items.map((item) => stringOf(item)).filter((item): item is string => item !== undefined) : []

const TYPES: Record<string, DbType> = {
  objectId: OBJECT_ID,
  string: { sql: 'string', kind: 'text' },
  int: { sql: 'int', kind: 'integer', bits: 32 },
  integer: { sql: 'int', kind: 'integer', bits: 64 },
  long: { sql: 'long', kind: 'integer', bits: 64 },
  double: { sql: 'double', kind: 'float', bits: 64 },
  number: { sql: 'number', kind: 'float', bits: 64 },
  decimal: { sql: 'decimal', kind: 'decimal' },
  bool: { sql: 'bool', kind: 'boolean' },
  boolean: { sql: 'bool', kind: 'boolean' },
  date: { sql: 'date', kind: 'datetime', timezone: true },
  timestamp: { sql: 'timestamp', kind: 'datetime', timezone: true },
  binData: { sql: 'binData', kind: 'binary' },
  object: { sql: 'object', kind: 'json' },
}

interface Reading {
  enums: DbEnum[]
  notes: DbNote[]
}

/** The type a `bsonType` (or `type`) names, and whether `null` is one of those it takes. */
function typeOf(schema: Map<string, Expr>, where: string, reading: Reading): { type: DbType; nullable: boolean } {
  const declared = schema.get('bsonType') ?? schema.get('type')
  const names = declared?.kind === 'list' ? stringsOf(declared) : [stringOf(declared)].filter((item): item is string => item !== undefined)
  const named = names.filter((name) => name !== 'null')
  const nullable = named.length < names.length
  // Whole numbers that may be of either size are kept in the larger one
  const name = named.length === 2 && named.includes('int') && named.includes('long') ? 'long' : named.length === 1 ? named[0] : undefined
  if (name === 'array') {
    const items = schema.get('items')
    const item = items?.kind === 'dict' ? typeOf(entriesOf(items), where, reading).type : TYPES.object
    return { type: { sql: `array<${item.sql}>`, kind: 'array', items: withEnum(item, entriesOf(items), where, reading) }, nullable }
  }
  if ((name === undefined || name === 'object') && schema.has('properties'))
    return { type: { sql: 'object', kind: 'json', fields: fieldsOf(schema, where, reading).map((field) => field.column) }, nullable }
  if (name !== undefined && TYPES[name]) return { type: TYPES[name], nullable }
  if (named.length > 0 && named.every((item) => ['int', 'long', 'double', 'decimal', 'number'].includes(item)))
    return { type: TYPES.number, nullable }
  // A list of values says the type of a field that has none
  const first = schema.get('enum')?.kind === 'list' ? literalOf((schema.get('enum') as Expr & { kind: 'list' }).items[0]) : undefined
  if (names.length === 0 && typeof first === 'string') return { type: TYPES.string, nullable }
  if (names.length === 0 && typeof first === 'number') return { type: TYPES.number, nullable }
  return { type: names.length === 0 || names.length > 1 ? TYPES.object : { sql: names.join(' | '), kind: 'unknown' }, nullable }
}

function enumValues(expr: Expr | undefined): (string | number)[] {
  return expr?.kind === 'list'
    ? expr.items
        .map((item) => literalOf(item))
        .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    : []
}

/** A text with a list of values inside a document, as an enum. */
function withEnum(type: DbType, schema: Map<string, Expr>, where: string, reading: Reading): DbType {
  const values = enumValues(schema.get('enum'))
  if (values.length === 0 || type.kind !== 'text') return type
  const name = where.replace(/\W+/g, '_')
  if (!reading.enums.some((item) => item.name === name)) reading.enums.push({ name, values: values.map(String), storage: 'check' })
  return { sql: 'string', kind: 'enum', name }
}

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

function fieldsOf(schema: Map<string, Expr>, where: string, reading: Reading): { column: DbColumn; checks: DbCheck[] }[] {
  const required = stringsOf(schema.get('required'))
  const nested = where.includes('.')
  return [...entriesOf(schema.get('properties'))].map(([name, value]) => {
    const field = entriesOf(value)
    const path = `${where}.${name}`
    const read = typeOf(field, path, reading)
    if (read.type.kind === 'unknown')
      reading.notes.push({
        code: 'orm.unknownType',
        params: { table: where.split('.')[0], column: path.slice(path.indexOf('.') + 1), type: textOf(value) },
      })
    const column: DbColumn = { name, type: read.type, nullable: (!required.includes(name) || read.nullable) && name !== '_id' }
    const checks: DbCheck[] = []
    const values = enumValues(field.get('enum'))
    if (nested) column.type = withEnum(column.type, field, path, reading)
    else if (values.length > 0) checks.push(checkOf(`${name} IN (${quoted(values)})`))
    const number = (key: string) => numberOf(field.get(key))
    if (column.type.kind === 'text' && number('maxLength') !== undefined && !isObjectId(column.type))
      column.type = { ...column.type, length: number('maxLength') }
    {
      const exclusive = (key: string) => booleanOf(field.get(key)) === true
      if (number('minimum') !== undefined)
        checks.push(checkOf(`${name} ${exclusive('exclusiveMinimum') ? '>' : '>='} ${number('minimum')}`))
      if (number('maximum') !== undefined)
        checks.push(checkOf(`${name} ${exclusive('exclusiveMaximum') ? '<' : '<='} ${number('maximum')}`))
      if (number('minLength') !== undefined) checks.push(checkOf(`LENGTH(${name}) >= ${number('minLength')}`))
    }
    if (nested && checks.length > 0) column.checks = checks.splice(0)
    const comment = stringOf(field.get('description'))
    if (comment) column.comment = comment
    return { column, checks }
  })
}

function tableOf(name: string, schema: Expr, line: number, reading: Reading): DbTable {
  const table: DbTable = {
    name,
    columns: [],
    primaryKey: ['_id'],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    origin: { line, column: 1 },
  }
  for (const field of fieldsOf(entriesOf(schema), name, reading)) {
    table.columns.push(field.column)
    table.checks.push(...field.checks)
  }
  const id = table.columns.find((column) => column.name === '_id')
  if (!id) table.columns.unshift(idColumn())
  else if (isObjectId(id.type)) id.generated = 'uuid'
  return table
}

/** The `$jsonSchema` of the options of a collection. */
const validatorOf = (options: Expr | undefined): Expr | undefined => entriesOf(entriesOf(options).get('validator')).get('$jsonSchema')

function readMongodb(files: SourceFile[]): DbSchema {
  const reading: Reading = { enums: [], notes: [] }
  const tables: DbTable[] = []
  const indexes: { collection: string; args: Expr[] }[] = []
  const add = (name: string, schema: Expr | undefined, line: number) => {
    // Nothing says what its documents hold
    if (!schema) reading.notes.push({ code: 'orm.noValidator', params: { table: name }, origin: { line, column: 1 } })
    if (schema && !tables.some((table) => table.name === name)) tables.push(tableOf(name, schema, line, reading))
  }
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
    // What `db.getCollectionInfos()` prints, or one validator alone
    if (['[', '{'].includes(tokens[0]?.value)) {
      const value = readExpression(cursor, file.text, SYNTAX)
      for (const item of value.kind === 'list' ? value.items : [value]) {
        const entries = entriesOf(item)
        const name = stringOf(entries.get('name'))
        if (name) add(name, validatorOf(entries.get('options')) ?? validatorOf(item), 1)
        else if (entries.has('$jsonSchema'))
          add(stringOf(entriesOf(entries.get('$jsonSchema')).get('title')) ?? 'documents', entries.get('$jsonSchema'), 1)
      }
      continue
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token.kind !== 'ident' || tokens[index + 1]?.value !== '(') continue
      if (token.value === 'createCollection') {
        const args = argumentsAt(index + 2)
        const name = stringOf(args[0])
        if (name) add(name, validatorOf(args[1]), token.line)
      } else if (token.value === 'runCommand') {
        // db.runCommand({ collMod: 'orders', validator: … })
        const [command] = argumentsAt(index + 2)
        const name = stringOf(entriesOf(command).get('collMod')) ?? stringOf(entriesOf(command).get('create'))
        if (name) add(name, validatorOf(command), token.line)
      } else if (token.value === 'createIndex' && tokens[index - 1]?.value === '.') {
        // db.orders.createIndex(…), db.getCollection('orders').createIndex(…)
        const before = tokens[index - 2]
        const collection = before?.value === ')' ? tokens[index - 3] : before
        if (collection) indexes.push({ collection: collection.value, args: argumentsAt(index + 2) })
      }
    }
  }
  for (const { collection, args } of indexes) {
    const table = tables.find((item) => item.name === collection)
    const options = entriesOf(args[1])
    if (table)
      addIndex(
        table,
        [...entriesOf(args[0]).keys()],
        booleanOf(options.get('unique')) === true,
        stringOf(options.get('name')),
        reading.notes,
      )
  }
  return {
    format: 'db-schema',
    version: 1,
    dialect: 'mongodb',
    source: { kind: 'orm', format: 'mongodb' },
    tables,
    enums: reading.enums,
    notes: reading.notes,
  }
}

export const mongodbReader: OrmReader = {
  id: 'mongodb',
  label: 'MongoDB validators',
  language: 'typescript',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\$jsonSchema/.test(text) && /\b(bsonType|properties)\b/.test(text) ? 0.95 : 0
  },
  read: readMongodb,
}
