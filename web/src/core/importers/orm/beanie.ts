/**
 * Reads Beanie documents into the physical schema: every `Document` is a collection (named by its `Settings`, or by the
 * class), with the fields of its annotations and of the classes it extends, their `Field(...)` (alias, default, limits),
 * its indexes (`Indexed`, `Settings.indexes`) and the Pydantic models it holds as nested documents. A `Link` is kept as
 * what Beanie stores, a document of its own (`{ $ref, $id }`), so it is not read as a foreign key.
 */
import { checkOf } from '../../schema/checks.ts'
import { idColumn, isObjectId, OBJECT_ID } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { Cursor, tokenize } from '../code/lexer.ts'
import { PYTHON_LEXER } from '../code/python.ts'
import { booleanOf, literalOf, nameOf, numberOf, readExpression, stringOf, type Expr } from './expressions.ts'
import { addIndex } from './mongoose.ts'
import { assignmentOf, attributesOf, classOf, emptyTable, isNow, isUuid, readModules, type ClassDef, type EnumClass } from './python.ts'
import type { OrmReader, SourceFile } from './types.ts'

const OBJECT: DbType = { sql: 'object', kind: 'json' }
const DATE: DbType = { sql: 'date', kind: 'datetime', timezone: true }
const DECIMAL: DbType = { sql: 'decimal', kind: 'decimal' }
const TEXT: DbType = { sql: 'str', kind: 'text' }

const TYPES: Record<string, DbType> = {
  str: TEXT,
  EmailStr: TEXT,
  AnyUrl: TEXT,
  HttpUrl: TEXT,
  SecretStr: TEXT,
  int: { sql: 'int', kind: 'integer', bits: 64 },
  PositiveInt: { sql: 'int', kind: 'integer', bits: 64 },
  NonNegativeInt: { sql: 'int', kind: 'integer', bits: 64 },
  Int64: { sql: 'long', kind: 'integer', bits: 64 },
  float: { sql: 'double', kind: 'float', bits: 64 },
  PositiveFloat: { sql: 'double', kind: 'float', bits: 64 },
  NonNegativeFloat: { sql: 'double', kind: 'float', bits: 64 },
  timedelta: { sql: 'double', kind: 'float', bits: 64 },
  Decimal: DECIMAL,
  DecimalAnnotation: DECIMAL,
  Decimal128: DECIMAL,
  bool: { sql: 'bool', kind: 'boolean' },
  datetime: DATE,
  AwareDatetime: DATE,
  NaiveDatetime: DATE,
  date: DATE,
  UUID: { sql: 'UUID', kind: 'uuid' },
  UUID4: { sql: 'UUID', kind: 'uuid' },
  bytes: { sql: 'binData', kind: 'binary' },
  Binary: { sql: 'binData', kind: 'binary' },
  BsonBinary: { sql: 'binData', kind: 'binary' },
  PydanticObjectId: OBJECT_ID,
  ObjectId: OBJECT_ID,
  Any: OBJECT,
  object: OBJECT,
  dict: OBJECT,
  Dict: OBJECT,
  Mapping: OBJECT,
  Link: OBJECT,
}

const LISTS = new Set(['list', 'List', 'set', 'Set', 'Sequence', 'tuple', 'Tuple', 'Iterable'])

interface Reading {
  classes: Map<string, ClassDef>
  enums: Map<string, EnumClass>
  used: DbEnum[]
  notes: DbNote[]
  path: string[]
}

/** An annotation, taken apart: its type, whether it may be None, and the calls `Annotated` and `Indexed` add to it. */
interface Annotation {
  type: string
  args: string[]
  optional: boolean
  calls: (Expr & { kind: 'call' })[]
}

/** The parts of a text between a separator, outside brackets and texts. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const char of text) {
    if (quote) quote = char === quote ? '' : quote
    else if (char === '"' || char === "'") quote = char
    else if ('[({'.includes(char)) depth++
    else if ('])}'.includes(char)) depth--
    if (char === separator && depth === 0 && !quote) {
      parts.push(current.trim())
      current = ''
    } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const expressionOf = (text: string): Expr => readExpression(new Cursor(tokenize(text, PYTHON_LEXER)), text)

/** The last name of a path: `datetime.datetime` → `datetime`. */
const last = (text: string) => text.split('.').at(-1)!.trim()

function annotationOf(written: string): Annotation {
  const text = written.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
  const options = splitTop(text, '|')
  if (options.length > 1) {
    const rest = options.filter((item) => item !== 'None')
    const inner: Annotation = rest.length === 1 ? annotationOf(rest[0]) : { type: 'Any', args: [], optional: false, calls: [] }
    return { ...inner, optional: inner.optional || rest.length < options.length }
  }
  const generic = /^([\w.]+)\s*\[([\s\S]*)\]$/.exec(text)
  if (generic) {
    const name = last(generic[1])
    const args = splitTop(generic[2], ',')
    if (name === 'Optional') return { ...annotationOf(args[0] ?? 'Any'), optional: true }
    if (name === 'Union') return annotationOf(args.join(' | '))
    if (name === 'Annotated') {
      const inner = annotationOf(args[0] ?? 'Any')
      const calls = args
        .slice(1)
        .map(expressionOf)
        .filter((item): item is Expr & { kind: 'call' } => item.kind === 'call')
      return { ...inner, calls: [...inner.calls, ...calls] }
    }
    return { type: name, args, optional: false, calls: [] }
  }
  const call = /^[\w.]+\s*\(/.test(text) ? expressionOf(text) : null
  if (call?.kind === 'call') {
    const [first] = call.args
    // Indexed(str, unique=True): the type is the first argument
    const inner = nameOf(call) === 'Indexed' && first?.kind === 'name' ? annotationOf(first.path.join('.')) : annotationOf('Any')
    return { ...inner, calls: [...inner.calls, call] }
  }
  return { type: last(text), args: [], optional: false, calls: [] }
}

function typeOf(annotation: Annotation, where: string, reading: Reading): DbType | null {
  const { type: name, args } = annotation
  if (LISTS.has(name)) {
    const item = typeOf(annotationOf(args[0] ?? 'Any'), where, reading)
    return item && { sql: args.length > 0 ? `${name}[${args.join(', ')}]` : name, kind: 'array', items: item }
  }
  if (name === 'Literal') {
    const values = args.map((item) => literalOf(expressionOf(item))).filter((item): item is string => typeof item === 'string')
    return enumType(where, values, reading)
  }
  const enumClass = reading.enums.get(name)
  if (enumClass) {
    const values = enumClass.members.map((member) => member.value)
    if (!values.every((value) => typeof value === 'string')) return TYPES.int
    return enumType(name, values as string[], reading)
  }
  if (TYPES[name]) return TYPES[name]
  const item = reading.classes.get(name)
  if (!item) return null
  if (reading.path.includes(name)) return OBJECT
  const fields = columnsOf(item, where, { ...reading, path: [...reading.path, name] }).map((read) => read.column)
  return { sql: name, kind: 'json', fields }
}

function enumType(name: string, values: string[], reading: Reading): DbType {
  if (!reading.used.some((other) => other.name === name)) reading.used.push({ name, values, storage: 'check' })
  return { sql: name, kind: 'enum', name }
}

interface FieldRead {
  attribute: string
  column: DbColumn
  checks: DbCheck[]
  index: { unique: boolean; name?: string } | null
}

const SKIPPED = new Set(['ClassVar', 'BackLink', 'PrivateAttr'])

const isDocument = (def: ClassDef, reading: Reading, seen: string[] = []): boolean =>
  def.bases.some((base) => {
    const name = last(base)
    const parent = reading.classes.get(name)
    if (!parent) return /^(Document|TimeSeries|View)$/.test(name)
    return !seen.includes(name) && isDocument(parent, reading, [...seen, name])
  })

function columnsOf(def: ClassDef, where: string, reading: Reading): FieldRead[] {
  const nested = where.includes('.')
  const result: FieldRead[] = []
  for (const item of attributesOf(def, reading.classes, () => true)) {
    if (!item.annotation || item.name.startsWith('_') || item.name === 'model_config' || item.name === 'revision_id') continue
    const annotation = annotationOf(item.annotation)
    if (SKIPPED.has(annotation.type) || annotation.args.some((arg) => SKIPPED.has(annotationOf(arg).type))) continue
    const fields = [...annotation.calls, ...(item.value?.kind === 'call' ? [item.value] : [])].filter((call) => nameOf(call) === 'Field')
    const given = (name: string): Expr | undefined => fields.map((call) => call.named[name]).find((value) => value !== undefined)
    const alias = stringOf(given('alias')) ?? stringOf(given('serialization_alias'))
    const name = alias ?? (item.name === 'id' && !nested ? '_id' : item.name)
    const path = `${where}.${name}`
    const type = typeOf(annotation, path, reading)
    if (!type)
      reading.notes.push({
        code: 'orm.unknownType',
        params: { table: where.split('.')[0], column: path.slice(path.indexOf('.') + 1), type: item.annotation },
      })
    const column: DbColumn = {
      name,
      type: type ?? { sql: item.annotation, kind: 'unknown' },
      nullable: annotation.optional && (name !== '_id' || nested),
    }
    const isField = item.value?.kind === 'call' && nameOf(item.value) === 'Field'
    const own = item.value && !isField ? item.value : undefined
    const value = own ?? given('default') ?? fields.map((call) => call.args[0]).find((arg) => arg !== undefined)
    const factory = given('default_factory')
    const made = factory ?? value
    const text = factory?.kind === 'other' ? factory.text : ''
    if (isNow(made) || /\b(now|utcnow)\(/.test(text)) column.generated = 'now'
    else if (column.type.kind === 'uuid' && (isUuid(made) || /\buuid4\(/.test(text))) column.generated = 'uuid'
    else if (name === '_id' && isObjectId(column.type)) column.generated = 'uuid'
    else if (factory || value?.kind === 'list' || value?.kind === 'dict') column.nullable = true
    else if (value) {
      const literal = literalOf(value)
      const member = value.kind === 'name' && value.path.length >= 2 ? value.path : null
      const ofEnum = member && reading.enums.get(member[member.length - 2])?.members.find((one) => one.name === member.at(-1))
      if (ofEnum) column.default = { kind: 'literal', value: ofEnum.value }
      else if (literal !== undefined && literal !== null) column.default = { kind: 'literal', value: literal }
    }
    const checks: DbCheck[] = []
    const limit = (key: string) => numberOf(given(key))
    const longest = limit('max_length')
    const shortest = limit('min_length')
    if (column.type.kind === 'text' && !isObjectId(column.type)) {
      if (longest !== undefined) column.type = { ...column.type, length: longest }
      if (shortest !== undefined && shortest > 0) checks.push(checkOf(`LENGTH(${name}) >= ${shortest}`))
    }
    const bounds: [string, string][] = [
      ['ge', '>='],
      ['gt', '>'],
      ['le', '<='],
      ['lt', '<'],
    ]
    for (const [key, op] of bounds) {
      const bound = limit(key)
      if (bound !== undefined) checks.push(checkOf(`${name} ${op} ${bound}`))
    }
    if (/^Positive/.test(annotation.type)) checks.push(checkOf(`${name} > 0`))
    if (/^NonNegative/.test(annotation.type)) checks.push(checkOf(`${name} >= 0`))
    if (nested && checks.length > 0) column.checks = checks.splice(0)
    const indexed = annotation.calls.find((call) => nameOf(call) === 'Indexed')
    const indexName = stringOf(indexed?.named.name)
    const index = indexed
      ? { unique: booleanOf(indexed.named.unique) === true, ...(indexName !== undefined ? { name: indexName } : {}) }
      : null
    result.push({ attribute: item.name, column, checks, index })
  }
  return result
}

/** What the `Settings` class of a document says, its own or that of a class it extends. */
function settingOf(def: ClassDef, name: string, reading: Reading, seen: string[] = []): Expr | null {
  for (const statement of def.body) {
    const inner = classOf(statement)
    if (inner?.name !== 'Settings') continue
    const found = inner.body.map(assignmentOf).find((item) => item?.name === name)
    if (found?.value) return found.value
  }
  for (const base of def.bases) {
    const parent = reading.classes.get(last(base))
    if (!parent || seen.includes(parent.name)) continue
    const found = settingOf(parent, name, reading, [...seen, def.name])
    if (found) return found
  }
  return null
}

const ownSetting = (def: ClassDef, name: string, reading: Reading) => settingOf({ ...def, bases: [] }, name, reading)

/** The fields of an index: `"name"`, `[("name", 1)]`, or the argument of `IndexModel`. */
function indexKeys(expr: Expr | undefined): string[] {
  const single = stringOf(expr)
  if (single !== undefined) return [single]
  if (expr?.kind !== 'list') return []
  return expr.items
    .map((item) => stringOf(item) ?? (item.kind === 'list' ? stringOf(item.items[0]) : undefined))
    .filter((item) => item !== undefined)
}

function readBeanie(files: SourceFile[]): DbSchema {
  const { classes: defs, enums } = readModules(files)
  const classes = new Map(defs.map((def) => [def.name, def]))
  const notes: DbNote[] = []
  const used: DbEnum[] = []
  const tables: DbTable[] = []
  const root: Reading = { classes, enums, used, notes, path: [] }
  const documents = defs.filter((def) => isDocument(def, root))
  for (const def of documents) {
    const parents = def.bases.map((base) => classes.get(last(base))).filter((parent) => parent !== undefined)
    // The documents of a root share its collection, and a class others extend with no name of its own is only their base
    if (parents.some((parent) => isDocument(parent, root) && booleanOf(settingOf(parent, 'is_root', root) ?? undefined) === true)) continue
    const extended = documents.some((other) => other !== def && other.bases.some((base) => last(base) === def.name))
    if (extended && !ownSetting(def, 'name', root) && booleanOf(ownSetting(def, 'is_root', root) ?? undefined) !== true) continue
    const table = emptyTable(stringOf(ownSetting(def, 'name', root) ?? undefined) ?? def.name, def.line)
    table.primaryKey = ['_id']
    table.entity = def.name
    const read = columnsOf(def, table.name, { ...root, path: [def.name] })
    for (const field of read) {
      table.columns.push(field.column)
      table.checks.push(...field.checks)
    }
    if (!table.columns.some((column) => column.name === '_id')) table.columns.unshift(idColumn())
    for (const { column, index } of read) if (index) addIndex(table, [column.name], index.unique, index.name, notes)
    const indexes = settingOf(def, 'indexes', root)
    for (const item of indexes?.kind === 'list' ? indexes.items : []) {
      const model = item.kind === 'call' ? item : null
      addIndex(
        table,
        indexKeys(model ? (model.args[0] ?? model.named.keys) : item),
        booleanOf(model?.named.unique) === true,
        stringOf(model?.named.name),
        notes,
      )
    }
    tables.push(table)
  }
  return {
    format: 'db-schema',
    version: 1,
    dialect: 'mongodb',
    source: { kind: 'orm', format: 'beanie' },
    tables,
    enums: used,
    notes,
  }
}

export const beanieReader: OrmReader = {
  id: 'beanie',
  label: 'Beanie',
  language: 'python',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\b(from|import)\s+beanie\b/.test(text) ? 1 : 0
  },
  read: readBeanie,
}
