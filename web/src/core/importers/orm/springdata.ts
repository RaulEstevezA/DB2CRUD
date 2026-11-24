/**
 * Reads Spring Data MongoDB classes into the physical schema: every `@Document` is a collection, with its fields
 * (`@Field`, `@Id`, `@Transient`), their Java types, what must be there (`@NotNull` and the like) and its limits, its
 * indexes (`@Indexed`, `@CompoundIndex`), its references (`@DocumentReference`, `@DBRef`) and the classes it holds as
 * nested documents. A reference to one document of a collection the code declares is read as a foreign key.
 */
import { checkOf } from '../../schema/checks.ts'
import { idColumn, isObjectId, OBJECT_ID } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { booleanOf, literalOf, nameOf, numberOf, stringOf } from './expressions.ts'
import { annotationOf, argumentOf, callsOf, readClasses, simpleType, type Field, type JavaClass } from './jpa.ts'
import { addIndex } from './mongoose.ts'
import type { OrmReader, SourceFile } from './types.ts'

const TYPES: Record<string, DbType> = {
  String: { sql: 'String', kind: 'text' },
  Integer: { sql: 'Integer', kind: 'integer', bits: 32 },
  int: { sql: 'int', kind: 'integer', bits: 32 },
  Short: { sql: 'Short', kind: 'integer', bits: 32 },
  short: { sql: 'short', kind: 'integer', bits: 32 },
  Long: { sql: 'long', kind: 'integer', bits: 64 },
  long: { sql: 'long', kind: 'integer', bits: 64 },
  Double: { sql: 'double', kind: 'float', bits: 64 },
  double: { sql: 'double', kind: 'float', bits: 64 },
  Float: { sql: 'double', kind: 'float', bits: 64 },
  float: { sql: 'double', kind: 'float', bits: 64 },
  BigDecimal: { sql: 'decimal', kind: 'decimal' },
  Decimal128: { sql: 'decimal', kind: 'decimal' },
  Boolean: { sql: 'bool', kind: 'boolean' },
  boolean: { sql: 'bool', kind: 'boolean' },
  Instant: { sql: 'date', kind: 'datetime', timezone: true },
  Date: { sql: 'date', kind: 'datetime', timezone: true },
  LocalDate: { sql: 'date', kind: 'datetime', timezone: true },
  LocalDateTime: { sql: 'date', kind: 'datetime', timezone: true },
  UUID: { sql: 'UUID', kind: 'uuid' },
  Binary: { sql: 'binData', kind: 'binary' },
  'byte[]': { sql: 'binData', kind: 'binary' },
  ObjectId: OBJECT_ID,
  Object: { sql: 'object', kind: 'json' },
  Document: { sql: 'object', kind: 'json' },
  Map: { sql: 'object', kind: 'json' },
}

const LISTS = new Set(['List', 'Set', 'Collection', 'ArrayList', 'LinkedHashSet', 'HashSet'])
const PRIMITIVES = new Set(['int', 'short', 'long', 'double', 'float', 'boolean'])

interface Reading {
  classes: Map<string, JavaClass>
  enums: DbEnum[]
  notes: DbNote[]
  path: string[]
}

/** The fields of a class and of those it extends; constants and what is not stored are left out. */
function fieldsOfClass(item: JavaClass, reading: Reading, seen: string[] = []): Field[] {
  const parent = item.base && !seen.includes(item.base) ? reading.classes.get(item.base) : undefined
  return [
    ...(parent ? fieldsOfClass(parent, reading, [...seen, item.name]) : []),
    ...item.fields.filter(
      (field) => !field.modifiers.has('static') && !field.modifiers.has('transient') && !annotationOf(field.annotations, 'Transient'),
    ),
  ]
}

/** `List<OrderLine>` → `OrderLine`. */
const genericOf = (type: string) => /<([\s\S]*)>\s*$/.exec(type)?.[1].trim() ?? ''

/** What `@Field(targetType = FieldType.…)` stores. */
const TARGETS: Record<string, DbType> = {
  OBJECT_ID: OBJECT_ID,
  DECIMAL128: TYPES.BigDecimal,
  STRING: TYPES.String,
  INT32: TYPES.Integer,
  INT64: TYPES.Long,
  DOUBLE: TYPES.Double,
  DATE_TIME: TYPES.Instant,
  BINARY: TYPES.Binary,
}

function typeOf(java: string, target: DbType | undefined, where: string, reading: Reading): DbType | null {
  if (/\[\]\s*$/.test(java) && simpleType(java.replace(/\[\]\s*$/, '')) !== 'byte') {
    const item = typeOf(java.replace(/\[\]\s*$/, ''), target, where, reading)
    return item && { sql: java, kind: 'array', items: item }
  }
  const name = simpleType(java)
  if (LISTS.has(name)) {
    const item = typeOf(genericOf(java) || 'Object', target, where, reading)
    return item && { sql: java, kind: 'array', items: item }
  }
  if (target) return target
  if (TYPES[name]) return TYPES[name]
  const item = reading.classes.get(name)
  if (!item) return null
  if (item.kind === 'enum') {
    if (!reading.enums.some((other) => other.name === item.name))
      reading.enums.push({ name: item.name, values: item.constants.map((constant) => constant.name), storage: 'check' })
    return { sql: name, kind: 'enum', name: item.name }
  }
  if (reading.path.includes(name)) return TYPES.Object
  const fields = columnsOf(item, where, { ...reading, path: [...reading.path, name] }).map((field) => field.column)
  return { sql: name, kind: 'json', fields }
}

interface FieldRead {
  field: Field
  column: DbColumn
  checks: DbCheck[]
  /** The class it refers to */
  ref?: string
}

const storedName = (field: Field): string => {
  const annotation = annotationOf(field.annotations, 'Field')
  return stringOf(argumentOf(annotation, 'name')) ?? stringOf(argumentOf(annotation, 'value')) ?? field.name
}

const isId = (field: Field) => annotationOf(field.annotations, 'Id', 'MongoId') !== undefined || field.name === 'id' || field.name === '_id'

/** The identifier of a class, which its references keep. */
function idTypeOf(item: JavaClass, reading: Reading): DbType {
  const field = fieldsOfClass(item, reading).find(isId)
  if (!field) return OBJECT_ID
  const name = simpleType(field.type)
  // Spring keeps a text that is an identifier as one
  if (name === 'String' || name === 'ObjectId') return OBJECT_ID
  return TYPES[name] ?? OBJECT_ID
}

function columnsOf(item: JavaClass, where: string, reading: Reading): FieldRead[] {
  const nested = where.includes('.')
  return fieldsOfClass(item, reading).map((field) => {
    const id = isId(field)
    const name = id ? '_id' : storedName(field)
    const path = `${where}.${name}`
    const reference = annotationOf(field.annotations, 'DocumentReference', 'DBRef')
    const list = LISTS.has(simpleType(field.type))
    const target = simpleType(list ? genericOf(field.type) : field.type)
    const referred = reference ? reading.classes.get(target) : undefined
    const fieldTarget = argumentOf(annotationOf(field.annotations, 'Field'), 'targetType')
    let type: DbType | null
    if (reference && annotationOf(field.annotations, 'DBRef')) {
      // A DBRef is a document of its own: { $ref, $id }
      type = list ? { sql: field.type, kind: 'array', items: TYPES.Object } : TYPES.Object
    } else if (reference) {
      const key = referred ? idTypeOf(referred, reading) : OBJECT_ID
      type = list ? { sql: field.type, kind: 'array', items: key } : key
    } else if (id) type = idTypeOf(item, reading)
    else type = typeOf(field.type, TARGETS[nameOf(fieldTarget) ?? ''], path, reading)
    if (!type)
      reading.notes.push({
        code: 'orm.unknownType',
        params: { table: where.split('.')[0], column: path.slice(path.indexOf('.') + 1), type: field.type },
      })
    const required = annotationOf(field.annotations, 'NotNull', 'NotBlank', 'NotEmpty', 'NonNull') !== undefined
    const column: DbColumn = {
      name,
      type: type ?? { sql: field.type, kind: 'unknown' },
      nullable: id ? nested : !required && !PRIMITIVES.has(field.type),
    }
    if (id && isObjectId(column.type)) column.generated = 'uuid'
    if (annotationOf(field.annotations, 'CreatedDate')) column.generated = 'now'
    if (annotationOf(field.annotations, 'LastModifiedDate')) column.generated = 'onUpdateNow'
    const literal = field.initializer ? literalOf(field.initializer) : undefined
    if (literal !== undefined && literal !== null && !column.generated) column.default = { kind: 'literal', value: literal }
    const constant = field.initializer?.kind === 'name' ? nameOf(field.initializer) : undefined
    if (constant && column.type.kind === 'enum' && field.initializer?.kind === 'name' && field.initializer.path.length === 2)
      column.default = { kind: 'literal', value: constant }
    const checks: DbCheck[] = []
    const size = annotationOf(field.annotations, 'Size')
    const max = numberOf(argumentOf(size, 'max'))
    const min = numberOf(argumentOf(size, 'min'))
    if (column.type.kind === 'text' && !isObjectId(column.type)) {
      if (max !== undefined) column.type = { ...column.type, length: max }
      if (min !== undefined && min > 0) checks.push(checkOf(`LENGTH(${name}) >= ${min}`))
    }
    const bound = (annotation: string) => {
      const value = argumentOf(annotationOf(field.annotations, annotation), 'value')
      return (
        numberOf(value) ?? (stringOf(value) !== undefined && !Number.isNaN(Number(stringOf(value))) ? Number(stringOf(value)) : undefined)
      )
    }
    const low = bound('Min') ?? bound('DecimalMin')
    const high = bound('Max') ?? bound('DecimalMax')
    if (low !== undefined) checks.push(checkOf(`${name} >= ${low}`))
    if (high !== undefined) checks.push(checkOf(`${name} <= ${high}`))
    if (annotationOf(field.annotations, 'Positive')) checks.push(checkOf(`${name} > 0`))
    if (annotationOf(field.annotations, 'PositiveOrZero')) checks.push(checkOf(`${name} >= 0`))
    if (nested && checks.length > 0) column.checks = checks.splice(0)
    const single = reference && !list && !annotationOf(field.annotations, 'DBRef')
    return { field, column, checks, ...(single && referred ? { ref: referred.name } : {}) }
  })
}

/** The fields of the keys of a compound index: `{'year': 1, 'number': -1}`. */
const keysOf = (definition: string): string[] => [...definition.matchAll(/['"]?([\w.]+)['"]?\s*:\s*(?:-?1|['"])/g)].map((match) => match[1])

function readSpringData(files: SourceFile[]): DbSchema {
  const classes = new Map(readClasses(files).map((item) => [item.name, item]))
  const enums: DbEnum[] = []
  const notes: DbNote[] = []
  const tables: DbTable[] = []
  const byClass = new Map<string, DbTable>()
  const pending: { table: DbTable; column: string; ref: string }[] = []
  for (const item of classes.values()) {
    const annotation = annotationOf(item.annotations, 'Document')
    if (!annotation || item.kind === 'interface') continue
    const name =
      stringOf(argumentOf(annotation, 'collection')) ??
      stringOf(argumentOf(annotation, 'value')) ??
      item.name.charAt(0).toLowerCase() + item.name.slice(1)
    const table: DbTable = {
      name,
      columns: [],
      primaryKey: ['_id'],
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: item.name,
      origin: { line: item.line, column: 1 },
    }
    const read = columnsOf(item, name, { classes, enums, notes, path: [item.name] })
    for (const { column, checks, ref } of read) {
      table.columns.push(column)
      table.checks.push(...checks)
      if (ref) pending.push({ table, column: column.name, ref })
    }
    if (!table.columns.some((column) => column.name === '_id')) table.columns.unshift(idColumn())
    const nameOfField = (key: string) => read.find(({ field }) => field.name === key)?.column.name ?? key
    for (const { field, column } of read) {
      const indexed = annotationOf(field.annotations, 'Indexed')
      if (indexed)
        addIndex(table, [column.name], booleanOf(argumentOf(indexed, 'unique')) === true, stringOf(argumentOf(indexed, 'name')), notes)
    }
    const compound = [
      ...item.annotations.filter((other) => nameOf(other) === 'CompoundIndex'),
      ...callsOf(argumentOf(annotationOf(item.annotations, 'CompoundIndexes'), 'value')),
    ]
    for (const index of compound) {
      const keys = keysOf(stringOf(argumentOf(index, 'def')) ?? '').map(nameOfField)
      addIndex(table, keys, booleanOf(argumentOf(index, 'unique')) === true, stringOf(argumentOf(index, 'name')), notes)
    }
    tables.push(table)
    byClass.set(item.name, table)
  }
  for (const { table, column, ref } of pending) {
    const target = byClass.get(ref)
    if (target) table.foreignKeys.push({ columns: [column], references: { table: target.name, columns: ['_id'] } })
    else notes.push({ code: 'orm.unknownReference', params: { table: table.name, column } })
  }
  return { format: 'db-schema', version: 1, dialect: 'mongodb', source: { kind: 'orm', format: 'springdata' }, tables, enums, notes }
}

export const springDataReader: OrmReader = {
  id: 'springdata',
  label: 'Spring Data MongoDB',
  language: 'java',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    if (!/@Document\b/.test(text)) return 0
    return /org\.springframework\.data\.mongodb\b/.test(text) ? 1 : /@Document\s*\(/.test(text) ? 0.6 : 0
  },
  read: readSpringData,
}
