/**
 * Deduces the collections of a MongoDB database from sample documents: what `mongoexport` and Compass write (JSON,
 * Extended JSON, one document per line), what mongosh prints (`ObjectId('…')`, `ISODate('…')`), a script that inserts
 * them, or an object with a list per collection. Documents say what there is, not what there must be, so it is careful:
 * a field is only required when enough documents have it, and unique values, limits and lists of values are never
 * deduced. No value of a document goes into the schema.
 */
import { idColumn, isObjectId, OBJECT_ID } from '../../schema/documents.ts'
import type { DbColumn, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import type { OrmReader, SourceFile } from './types.ts'

/** With fewer documents, being in all of them says little: nothing is required. */
const ENOUGH = 5
/** An object with more keys than this, few of them shared, holds data in its keys. */
const MANY_KEYS = 40
/** Deeper documents are cut: MongoDB allows 100 levels. */
const MAX_DEPTH = 100

type Scalar =
  | 'objectId'
  | 'text'
  | 'whole'
  | 'double'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'binary'
  | 'uuid'
  | 'null'
  /** Anything else MongoDB keeps: a regular expression, a timestamp */
  | 'other'
  /** What mongosh leaves out: `[Object]` */
  | 'cut'

type Value = { kind: 'object'; entries: Map<string, Value> } | { kind: 'array'; items: Value[] } | { kind: Scalar; text?: string }

// Reading the values

/** The types of Extended JSON, by their key. */
const EXTENDED: Record<string, Scalar> = {
  $oid: 'objectId',
  $date: 'date',
  $numberInt: 'whole',
  $numberLong: 'whole',
  $numberDouble: 'double',
  $numberDecimal: 'decimal',
  $uuid: 'uuid',
  $binary: 'binary',
  $timestamp: 'other',
  $regularExpression: 'other',
  $regex: 'other',
  $code: 'other',
  $symbol: 'text',
  $minKey: 'other',
  $maxKey: 'other',
  $undefined: 'null',
}

/** The functions mongosh writes values with. */
const CALLS: Record<string, Scalar> = {
  ObjectId: 'objectId',
  ISODate: 'date',
  Date: 'date',
  Int32: 'whole',
  NumberInt: 'whole',
  Long: 'whole',
  NumberLong: 'whole',
  Double: 'double',
  Decimal128: 'decimal',
  NumberDecimal: 'decimal',
  UUID: 'uuid',
  Binary: 'binary',
  BinData: 'binary',
  HexData: 'binary',
  Buffer: 'binary',
  Timestamp: 'other',
  MinKey: 'other',
  MaxKey: 'other',
  Code: 'other',
  BSONRegExp: 'other',
  RegExp: 'other',
  DBRef: 'other',
}

const UUID_SUBTYPES = new Set(['04', '4', '03', '3'])

/** An object of Extended JSON is the value it writes: `{ "$oid": "…" }`. */
function extended(value: Value): Value {
  if (value.kind !== 'object') return value
  const [first] = value.entries.keys()
  const kind = first === undefined ? undefined : EXTENDED[first]
  if (!kind) return value
  const inner = value.entries.get(first!)!
  if (kind === 'binary') {
    const subType = inner.kind === 'object' ? inner.entries.get('subType') : value.entries.get('$type')
    return { kind: subType && 'text' in subType && UUID_SUBTYPES.has(subType.text ?? '') ? 'uuid' : 'binary' }
  }
  return { kind, ...('text' in inner && inner.text !== undefined ? { text: inner.text } : {}) }
}

/** The values of a text, token by token; null where something is not a value. */
class Reader {
  index = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  get done(): boolean {
    return this.index >= this.tokens.length
  }

  token(offset = 0): Token | undefined {
    return this.tokens[this.index + offset]
  }

  is(value: string, offset = 0): boolean {
    const token = this.token(offset)
    return token !== undefined && token.kind !== 'string' && token.value === value
  }

  private eat(value: string): boolean {
    if (!this.is(value)) return false
    this.index++
    return true
  }

  /** Moves to a closing bracket of this level, or to something before it, past what is not a value: `... 3 more items`. */
  private skipTo(close: string, before = close): void {
    let depth = 0
    while (!this.done) {
      if (depth === 0 && (this.is(close) || this.is(before))) return
      if (this.is('{') || this.is('[') || this.is('(')) depth++
      else if (this.is('}') || this.is(']') || this.is(')')) depth--
      if (depth < 0) return
      this.index++
    }
  }

  value(depth = 0): Value | null {
    const token = this.token()
    if (!token || depth > MAX_DEPTH) return null
    if (token.kind === 'string') {
      this.index++
      return { kind: 'text', text: token.value }
    }
    if (token.kind === 'number' || (this.is('-') && (this.token(1)?.kind === 'number' || this.is('Infinity', 1)))) {
      if (token.kind !== 'number') this.index++
      let text = ''
      let end = this.token()!.start
      // The parts of one number touch each other: `1e-7`
      while (this.token() && this.token()!.start === end && !/^[,:[\]{}();]$/.test(this.token()!.value)) {
        text += this.token()!.value
        end = this.token()!.end
        this.index++
      }
      return { kind: /^\d+$/.test(text) ? 'whole' : 'double', text }
    }
    if (this.eat('{')) return this.object(depth)
    if (this.eat('[')) return this.array(depth)
    if (token.kind !== 'ident') return null
    if (token.value === 'new') {
      this.index++
      return this.value(depth)
    }
    if (['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(token.value)) {
      this.index++
      return {
        kind:
          token.value === 'true' || token.value === 'false'
            ? 'bool'
            : token.value === 'null' || token.value === 'undefined'
              ? 'null'
              : 'double',
      }
    }
    const kind = CALLS[token.value]
    // `Binary.createFromBase64('…', 0)`, `Long.fromBits(…)`
    let at = 1
    const method = kind && this.is('.', at) && this.token(at + 1)?.kind === 'ident' ? this.token(at + 1)!.value : ''
    if (method) at += 2
    if (!kind || !this.is('(', at)) return null
    this.index += at + 1
    const args: Value[] = []
    while (!this.done && !this.is(')')) {
      const arg = this.value(depth + 1)
      if (!arg) break
      args.push(arg)
      if (!this.eat(',')) break
    }
    this.skipTo(')')
    this.eat(')')
    const [first, second] = args
    // BinData(4, '…'), Binary.createFromBase64('…', 4)
    const subType = token.value === 'BinData' ? first : second
    if (kind === 'binary' && subType && 'text' in subType && UUID_SUBTYPES.has(subType.text ?? '')) return { kind: 'uuid' }
    return { kind, ...(first && 'text' in first && first.text !== undefined ? { text: first.text } : {}) }
  }

  private object(depth: number): Value {
    const entries = new Map<string, Value>()
    while (!this.done && !this.is('}')) {
      const key = this.token()!
      if (!['string', 'ident', 'number'].includes(key.kind) || !this.is(':', 1)) break
      this.index += 2
      const value = this.value(depth + 1)
      // Something it does not know is still a field
      if (!value) this.skipTo('}', ',')
      entries.set(key.value, value ?? { kind: 'other' })
      if (!this.eat(',')) break
    }
    this.skipTo('}')
    this.eat('}')
    return extended({ kind: 'object', entries })
  }

  private array(depth: number): Value {
    const items: Value[] = []
    // `[Object]` and `[Array]` are what mongosh does not print
    if ((this.is('Object') || this.is('Array')) && this.is(']', 1)) {
      this.index += 2
      return { kind: 'cut' }
    }
    while (!this.done && !this.is(']')) {
      const value = this.value(depth + 1)
      if (!value) break
      items.push(value)
      if (!this.eat(',')) break
    }
    this.skipTo(']')
    this.eat(']')
    return { kind: 'array', items }
  }
}

// Finding the documents

const isObject = (value: Value): value is Value & { kind: 'object' } => value.kind === 'object'

/** The documents of a value: itself, or those of a list. */
const documentsOf = (value: Value | null): (Value & { kind: 'object' })[] =>
  value === null ? [] : value.kind === 'array' ? value.items.filter(isObject) : isObject(value) ? [value] : []

/** `shop.customers.json`, as Compass names what it exports → `customers`; null when the name says nothing. */
function collectionOf(file: string): string | null {
  const name = file
    .split('/')
    .at(-1)!
    .replace(/\.(json|ndjson|jsonl|js|txt|bson)$/i, '')
    .split('.')
    .at(-1)!
  return name === '' || name === 'input' ? null : name
}

const INSERTS = new Set(['insertMany', 'insertOne', 'insert'])
const FINDS = new Set(['find', 'findOne', 'aggregate'])

interface Found {
  name: string
  named: boolean
  line: number
  documents: (Value & { kind: 'object' })[]
}

/** Whether a text holds documents of MongoDB: JSON or what mongosh prints, with an `_id`, or a script that inserts them. */
export function holdsDocuments(text: string): boolean {
  if (/\bdb\s*\.\s*[\w$]+(\s*\(\s*["'`][^"'`]+["'`]\s*\))?\s*\.\s*(insertMany|insertOne|insert)\s*\(/.test(text)) return true
  if (/\$jsonSchema/.test(text)) return false
  const start = text.trimStart()
  const printed = /^[[{]/.test(start) || /\bdb\s*\.\s*[\w$]+(\s*\([^)]*\))?\s*\.\s*(find|findOne|aggregate)\s*\(/.test(text)
  return printed && /(["']_id["']|\b_id)\s*:|["']\$oid["']\s*:/.test(text)
}

const PATTERN = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|([:,[]\s*)\/(?![/*])(?:\\.|[^\\/\n])+\/[a-z]*(?=\s*[,}\]])/g

/** A text with its regular expressions (`re: /it's/i`) as calls: what they hold is not tokens. */
const withoutPatterns = (text: string) =>
  text.replace(PATTERN, (found: string, before: string | undefined) => (before === undefined ? found : `${before}RegExp()`))

/** The documents of a file, by collection. */
function readFile(file: SourceFile): Found[] {
  let tokens: Token[]
  try {
    tokens = tokenize(withoutPatterns(file.text), TYPESCRIPT_LEXER)
  } catch {
    return []
  }
  const reader = new Reader(tokens)
  const found: Found[] = []
  const add = (name: string, named: boolean, line: number, documents: Found['documents']) => {
    const known = found.find((item) => item.name === name)
    if (known) known.documents.push(...documents)
    else if (documents.length > 0) found.push({ name, named, line, documents })
  }
  let current = collectionOf(file.name)
  while (!reader.done) {
    const token = reader.token()!
    if (reader.is('db') && reader.is('.', 1)) {
      // db.customers.insertMany([…]), db.getCollection('customers').find(), db['customers'] is not followed
      let at = 2
      let name = reader.token(at)?.value ?? ''
      at++
      if (name === 'getCollection' && reader.is('(', at)) {
        name = reader.token(at + 1)?.value ?? ''
        at += 3
      }
      // A name with points: db.audit.entries.find()
      while (reader.is('.', at) && reader.is('.', at + 2)) {
        name += `.${reader.token(at + 1)!.value}`
        at += 2
      }
      const method = reader.is('.', at) && reader.is('(', at + 2) ? reader.token(at + 1)!.value : ''
      if (INSERTS.has(method)) {
        reader.index += at + 3
        add(name, true, token.line, documentsOf(reader.value()))
        continue
      }
      if (FINDS.has(method)) {
        // What it prints comes after the call, and the calls that follow it
        current = name
        reader.index += at + 2
        for (;;) {
          let depth = 0
          do {
            if (reader.is('(')) depth++
            if (reader.is(')')) depth--
            reader.index++
          } while (!reader.done && depth > 0)
          if (!reader.is('.') || !reader.is('(', 2)) break
          reader.index += 2
        }
        continue
      }
      reader.index++
      continue
    }
    if (!reader.is('{') && !reader.is('[')) {
      reader.index++
      continue
    }
    const value = reader.value()
    if (!value) continue
    // An object with a list per collection
    if (isObject(value) && !value.entries.has('_id') && value.entries.size > 0) {
      const lists = [...value.entries.values()]
      if (lists.every((item) => item.kind === 'array' && item.items.length > 0 && item.items.every(isObject))) {
        for (const [name, list] of value.entries) add(name, true, token.line, documentsOf(list))
        continue
      }
    }
    add(current ?? 'documents', current !== null, token.line, documentsOf(value))
  }
  return found
}

// Deducing

interface Reading {
  table: string
  notes: DbNote[]
}

const NUMBERS = new Set<string>(['whole', 'double', 'decimal'])

const SIMPLE: Partial<Record<Value['kind'], DbType>> = {
  objectId: OBJECT_ID,
  text: { sql: 'string', kind: 'text' },
  whole: { sql: 'long', kind: 'integer', bits: 64 },
  double: { sql: 'double', kind: 'float', bits: 64 },
  decimal: { sql: 'decimal', kind: 'decimal' },
  bool: { sql: 'bool', kind: 'boolean' },
  date: { sql: 'date', kind: 'datetime', timezone: true },
  binary: { sql: 'binData', kind: 'binary' },
  uuid: { sql: 'UUID', kind: 'uuid' },
}

const OBJECT: DbType = { sql: 'object', kind: 'json' }

/** A key that is data and not the name of a field: an identifier, a number, a date, an address. */
const isData = (key: string) =>
  /^\d+$|^[0-9a-f]{24}$|^[0-9a-f]{8}-[0-9a-f]{4}-|^\d{4}-\d{2}(-\d{2})?|[@/]|^https?:/i.test(key) || key === '' || key.startsWith('$')

function typeOf(values: Value[], path: string, reading: Reading): DbType {
  const note = (code: string, params: Record<string, string | number> = {}) =>
    reading.notes.push({ code, params: { table: reading.table, column: path, ...params } })
  const present = values.filter((value) => value.kind !== 'null')
  const kinds = [...new Set(present.map((value) => value.kind))].sort()
  if (kinds.length === 0) {
    note('documents.onlyNull')
    return OBJECT
  }
  if (kinds.includes('cut')) {
    note('documents.cut')
    return OBJECT
  }
  if (kinds.length > 1) {
    // A number is whole or not from one document to another
    if (kinds.every((kind) => NUMBERS.has(kind))) return kinds.includes('decimal') ? SIMPLE.decimal! : SIMPLE.double!
    note('documents.mixedTypes', { types: kinds.join(', ') })
    return OBJECT
  }
  const [kind] = kinds
  if (kind === 'array') {
    const items = present.flatMap((value) => (value.kind === 'array' ? value.items : []))
    if (items.length === 0) {
      note('documents.emptyList')
      return { sql: 'array', kind: 'array', items: OBJECT }
    }
    const item = typeOf(items, path, reading)
    return { sql: `array<${item.sql}>`, kind: 'array', items: item }
  }
  if (kind === 'object') {
    const documents = present.filter(isObject)
    const keys = new Set(documents.flatMap((document) => [...document.entries.keys()]))
    const shared = documents.reduce((total, document) => total + document.entries.size, 0) / documents.length
    if ([...keys].some(isData) || (keys.size > MANY_KEYS && shared < keys.size / 4)) {
      note('documents.dataKeys')
      return OBJECT
    }
    // An empty document says nothing
    return keys.size === 0 ? OBJECT : { sql: 'object', kind: 'json', fields: fieldsOf(documents, `${path}.`, reading) }
  }
  const simple = SIMPLE[kind]
  if (simple) return simple
  note('documents.otherType')
  return OBJECT
}

function fieldsOf(documents: (Value & { kind: 'object' })[], prefix: string, reading: Reading): DbColumn[] {
  const fields = new Map<string, Value[]>()
  for (const document of documents)
    for (const [name, value] of document.entries) {
      const values = fields.get(name)
      if (values) values.push(value)
      else fields.set(name, [value])
    }
  return [...fields].map(([name, values]): DbColumn => {
    const always = documents.length >= ENOUGH && values.length === documents.length && values.every((value) => value.kind !== 'null')
    const root = prefix === ''
    return {
      name,
      type: typeOf(values, prefix + name, reading),
      nullable: root && name === '_id' ? false : !(always && name !== '_id'),
    }
  })
}

/** The identifiers of a value that is one, or a list of them. */
const identifiers = (value: Value | undefined): string[] =>
  value === undefined
    ? []
    : value.kind === 'array'
      ? value.items.flatMap(identifiers)
      : value.kind === 'objectId' && value.text
        ? [value.text.toLowerCase()]
        : []

function readDocuments(files: SourceFile[]): DbSchema {
  const found: Found[] = []
  for (const file of files.filter((item) => holdsDocuments(item.text)))
    for (const item of readFile(file)) {
      const known = found.find((other) => other.name === item.name)
      if (known) known.documents.push(...item.documents)
      else found.push(item)
    }
  const notes: DbNote[] = []
  const tables = found.map((item): DbTable => {
    const reading = { table: item.name, notes }
    if (!item.named) notes.push({ code: 'documents.unnamed', params: { table: item.name } })
    notes.push({
      code: item.documents.length < ENOUGH ? 'documents.few' : 'documents.deduced',
      params: { table: item.name, count: item.documents.length },
    })
    const columns = fieldsOf(item.documents, '', reading)
    const id = columns.find((column) => column.name === '_id')
    if (!id) columns.unshift(idColumn())
    else if (isObjectId(id.type)) id.generated = 'uuid'
    return {
      name: item.name,
      columns,
      primaryKey: ['_id'],
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      origin: { line: item.line, column: 1 },
    }
  })
  // An identifier of MongoDB is never repeated: a field that has one of another collection's points to it
  const owners = new Map<string, string>()
  for (const item of found)
    for (const document of item.documents) for (const id of identifiers(document.entries.get('_id'))) owners.set(id, item.name)
  found.forEach((item, index) => {
    for (const column of tables[index].columns) {
      if (column.name === '_id' || !isObjectId(column.type)) continue
      const targets = new Set(
        item.documents
          .flatMap((document) => identifiers(document.entries.get(column.name)))
          .map((id) => owners.get(id))
          .filter((name) => name !== undefined),
      )
      if (targets.size !== 1) continue
      const [target] = targets
      tables[index].foreignKeys.push({ columns: [column.name], references: { table: target, columns: ['_id'] } })
      notes.push({ code: 'documents.reference', params: { table: item.name, column: column.name, target } })
    }
  })
  return {
    format: 'db-schema',
    version: 1,
    dialect: 'mongodb',
    source: { kind: 'orm', format: 'documents' },
    tables,
    enums: [],
    notes,
  }
}

export const documentsReader: OrmReader = {
  id: 'documents',
  label: 'MongoDB documents',
  language: 'json',
  // Code of an ORM may insert documents too: it says more
  detect: (files) => (files.some((file) => holdsDocuments(file.text)) ? 0.3 : 0),
  read: readDocuments,
}
