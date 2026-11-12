/**
 * `prisma/schema.prisma`: a model per table that reflects the database instead of designing it (exact table
 * and column names with `@map`, the native types of the chosen database, keys, unique values, indexes and
 * foreign keys with their actions), the enums the database keeps as types, and the generator of the client
 * into src/generated/prisma. Prisma never migrates with it: the database already exists; the tests create
 * their own database from it.
 */
import type { DbColumn, DbEnum, DbForeignKey, DbType, ReferentialAction } from '../../../schema/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { memberName, typeName } from '../typescript.ts'
import { columnOf, findInfo, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'

export type Provider = 'postgresql' | 'mysql' | 'sqlite'

export function providerOf(context: Context): Provider {
  const database = context.settings.database
  return database === 'mysql' || database === 'mariadb' ? 'mysql' : database === 'sqlite' ? 'sqlite' : 'postgresql'
}

const prismaString = (value: string) => JSON.stringify(value)

// Enums

/** The enum of a column, when the database keeps it as a type of its own (Prisma enum); CHECK enums stay text. */
export function nativeEnum(context: Context, type: DbType): DbEnum | undefined {
  if (type.kind !== 'enum' || providerOf(context) === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

export const enumName = (item: DbEnum) => typeName(item.name)

/** The Prisma name of an enum value: the value itself when it is an identifier. */
export function memberOf(value: string): string {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) return value
  const cleaned = value.replace(/\W+/g, '_').replace(/^_+|_+$/g, '')
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `value_${cleaned}`
}

/** Whether any value of the enum has another name in Prisma: the client returns the names, not the values. */
export const renamesValues = (item: DbEnum) => item.values.some((value) => memberOf(value) !== value)

function enumBlock(item: DbEnum): string[] {
  return [
    `enum ${enumName(item)} {`,
    ...item.values.map((value) => `  ${memberOf(value)}${memberOf(value) !== value ? ` @map(${prismaString(value)})` : ''}`),
    '',
    `  @@map(${prismaString(item.name)})`,
    '}',
  ]
}

// Columns

/** How a column is kept by Prisma: its scalar type, and the native type when Prisma's default is not the column's. */
export interface PrismaField {
  type: string
  native?: string
}

/** The precision written in the column's SQL type: `timestamp(3)` → 3. */
const precisionOf = (type: DbType) => /\((\d+)\)/.exec(type.sql)?.[1]

export function fieldOf(context: Context, type: DbType): PrismaField {
  const provider = providerOf(context)
  const sqlite = provider === 'sqlite'
  const postgres = provider === 'postgresql'
  switch (type.kind) {
    case 'integer':
      // SQLite keeps every whole number in 64 bits, and Prisma only counts up Int keys there
      if (type.bits === 64 && !sqlite) return { type: 'BigInt' }
      return type.bits === 16 && !sqlite ? { type: 'Int', native: '@db.SmallInt' } : { type: 'Int' }
    case 'decimal':
      return sqlite || type.precision === undefined
        ? { type: 'Decimal' }
        : { type: 'Decimal', native: `@db.Decimal(${type.precision}, ${type.scale ?? 0})` }
    case 'float':
      if (type.bits === 32 && !sqlite) return { type: 'Float', native: postgres ? '@db.Real' : '@db.Float' }
      return { type: 'Float' }
    case 'text':
      if (sqlite) return { type: 'String' }
      if (type.length === undefined) return postgres ? { type: 'String' } : { type: 'String', native: '@db.Text' }
      return { type: 'String', native: `@db.${type.fixed ? 'Char' : 'VarChar'}(${type.length})` }
    case 'boolean':
      return { type: 'Boolean' }
    case 'date':
      return sqlite ? { type: 'DateTime' } : { type: 'DateTime', native: '@db.Date' }
    case 'time': {
      if (sqlite) return { type: 'String' }
      const precision = precisionOf(type) ?? (postgres ? '6' : '0')
      return { type: 'DateTime', native: `@db.${postgres && type.timezone ? 'Timetz' : 'Time'}(${precision})` }
    }
    case 'datetime': {
      if (sqlite) return { type: 'DateTime' }
      const precision = precisionOf(type) ?? (postgres ? '6' : '0')
      return {
        type: 'DateTime',
        native: postgres ? `@db.${type.timezone ? 'Timestamptz' : 'Timestamp'}(${precision})` : `@db.DateTime(${precision})`,
      }
    }
    case 'uuid':
      return sqlite ? { type: 'String' } : { type: 'String', native: postgres ? '@db.Uuid' : '@db.Char(36)' }
    case 'binary':
      if (provider === 'mysql') return { type: 'Bytes', native: type.length !== undefined ? `@db.VarBinary(${type.length})` : '@db.Blob' }
      return { type: 'Bytes' }
    case 'json':
      return postgres && /^json$/i.test(type.sql) ? { type: 'Json', native: '@db.Json' } : { type: 'Json' }
    case 'array':
      // Arrays are portable as JSON; a native PostgreSQL list is a decision for the user
      return { type: 'Json' }
    case 'enum': {
      const item = nativeEnum(context, type)
      return item ? { type: enumName(item) } : { type: 'String' }
    }
    case 'unknown':
      return { type: 'String' }
  }
}

function defaultOf(context: Context, column: DbColumn): string | null {
  const value = column.default
  if (!value) return null
  if (value.kind === 'expression') return `@default(dbgenerated(${prismaString(value.sql)}))`
  if (value.value === null) return null
  const item = nativeEnum(context, column.type)
  if (item) return `@default(${memberOf(String(value.value))})`
  if (typeof value.value === 'string') {
    // A Prisma Decimal or BigInt default is written as a number
    if ((column.type.kind === 'decimal' || column.type.kind === 'integer') && /^-?\d+(\.\d+)?$/.test(value.value))
      return `@default(${value.value})`
    return `@default(${prismaString(value.value)})`
  }
  return `@default(${String(value.value)})`
}

function scalarLine(context: Context, info: TableInfo, column: ColumnInfo): { line: string; notes: string[] } {
  const db = column.column
  const { type, native } = fieldOf(context, db.type)
  const single = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  const notes: string[] = []
  const parts = [`${column.prop} ${type}${db.nullable && !single ? '?' : ''}`]
  if (single) parts.push('@id')
  if (db.generated === 'identity') parts.push('@default(autoincrement())')
  else if (db.generated === 'uuid') parts.push('@default(uuid())')
  else if (db.generated === 'now') parts.push('@default(now())')
  else if (db.generated === 'onUpdateNow') parts.push('@default(now()) @updatedAt')
  else {
    const value = defaultOf(context, db)
    if (value) parts.push(value)
  }
  const unique = info.table.uniques.find((item) => item.columns.length === 1 && item.columns[0] === db.name)
  if (unique) parts.push(unique.name ? `@unique(map: ${prismaString(unique.name)})` : '@unique')
  if (column.prop !== db.name) parts.push(`@map(${prismaString(db.name)})`)
  if (native) parts.push(native)
  if (typeof db.generated === 'object')
    notes.push(
      `TODO: ${db.name} is computed by the database (${db.generated.computed}); Prisma cannot say so, and the repositories never write it`,
    )
  if (db.type.kind === 'unknown') notes.push(`TODO: "${db.type.sql}" has no Prisma type here; it is mapped as text`)
  if (db.type.kind === 'array')
    notes.push(`TODO: "${db.type.sql}" is mapped as JSON; use a Prisma list on PostgreSQL if you need the native array`)
  if (db.comment) notes.push(db.comment)
  return { line: parts.join(' '), notes }
}

// Relations

const ACTIONS: Record<ReferentialAction, string> = {
  cascade: 'Cascade',
  'set null': 'SetNull',
  'set default': 'SetDefault',
  restrict: 'Restrict',
  'no action': 'NoAction',
}

interface Relation {
  key: DbForeignKey
  child: TableInfo
  parent: TableInfo
  name: string
  field: string
  back: string
}

/** Whether the columns are a key of the table (primary or unique): then a row has at most one such row. */
function isUniqueSet(info: TableInfo, columns: string[]): boolean {
  const same = (other: string[]) => other.length === columns.length && other.every((name) => columns.includes(name))
  return (info.table.primaryKey !== null && same(info.table.primaryKey)) || info.table.uniques.some((unique) => same(unique.columns))
}

/** Every foreign key Prisma can keep: the parent is in the schema and the referenced columns are one of its keys. */
export function relationsOf(context: Context): Relation[] {
  const taken = new Map(context.tables.map((info) => [info.name, new Set(info.columns.map((column) => column.prop))]))
  const free = (table: string, wanted: string) => {
    const names = taken.get(table)!
    let name = wanted
    for (let index = 2; names.has(name); index++) name = `${wanted}${index}`
    names.add(name)
    return name
  }
  const result: Relation[] = []
  for (const child of context.tables)
    for (const key of child.table.foreignKeys) {
      const parent = findInfo(context, key.references.table)
      if (!parent || !isUniqueSet(parent, key.references.columns)) continue
      const base = key.attribute ?? (key.columns.length === 1 ? memberName(key.columns[0].replace(/_id$/i, '')) : memberName(parent.name))
      const field = free(child.name, taken.get(child.name)!.has(base) ? `${base}Ref` : base)
      result.push({ key, child, parent, name: `${child.entity}_${field}`, field, back: '' })
    }
  // The other side of each relation, once every relation field is named
  for (const relation of result) {
    const wanted = relation.key.inverse ?? relation.child.attr
    const repeated = result.some((other) => other !== relation && other.child === relation.child && other.parent === relation.parent)
    relation.back = free(
      relation.parent.name,
      repeated ? `${wanted}As${relation.field.charAt(0).toUpperCase()}${relation.field.slice(1)}` : wanted,
    )
  }
  return result
}

function relationLine(context: Context, relation: Relation): string {
  const { key, child, parent } = relation
  const optional = key.columns.some((name) => columnOf(child, name).column.nullable)
  const fields = key.columns.map((name) => columnOf(child, name).prop)
  const references = key.references.columns.map((name) => columnOf(parent, name).prop)
  const parts = [
    prismaString(relation.name),
    `fields: [${fields.join(', ')}]`,
    `references: [${references.join(', ')}]`,
    `onDelete: ${ACTIONS[key.onDelete ?? 'no action']}`,
    `onUpdate: ${ACTIONS[key.onUpdate ?? 'no action']}`,
  ]
  // SQLite has no names for foreign keys
  if (key.name && providerOf(context) !== 'sqlite') parts.push(`map: ${prismaString(key.name)}`)
  return `${relation.field} ${parent.entity}${optional ? '?' : ''} @relation(${parts.join(', ')})`
}

function backLine(relation: Relation): string {
  const one = isUniqueSet(relation.child, relation.key.columns)
  return `${relation.back} ${relation.child.entity}${one ? '?' : '[]'} @relation(${prismaString(relation.name)})`
}

// Models

/** Columns as the attributes of a block list them: MySQL can only index long text by a prefix. */
function columnList(context: Context, info: TableInfo, names: string[]): string {
  return names
    .map((name) => {
      const column = columnOf(info, name)
      const longText = column.column.type.kind === 'text' && column.column.type.length === undefined
      return providerOf(context) === 'mysql' && (longText || column.column.type.kind === 'unknown')
        ? `${column.prop}(length: 191)`
        : column.prop
    })
    .join(', ')
}

/** Names, types and attributes in columns, as `prisma format` leaves them. */
function aligned(fields: { line: string; notes: string[] }[]): string[] {
  const parts = fields.map((field) => field.line.split(' '))
  const nameWidth = Math.max(...parts.map(([name]) => name.length))
  const typeWidth = Math.max(...parts.map(([, type]) => type.length))
  return fields.flatMap((field, index) => {
    const [name, type, ...rest] = parts[index]
    const line =
      rest.length > 0 ? `${name.padEnd(nameWidth)} ${type.padEnd(typeWidth)} ${rest.join(' ')}` : `${name.padEnd(nameWidth)} ${type}`
    return [...field.notes.map((note) => `  /// ${note}`), `  ${line}`]
  })
}

function modelBlock(context: Context, info: TableInfo, relations: Relation[]): string[] {
  const { table } = info
  const fields = info.columns.map((column) => scalarLine(context, info, column))
  for (const relation of relations.filter((item) => item.child === info)) fields.push({ line: relationLine(context, relation), notes: [] })
  for (const relation of relations.filter((item) => item.parent === info)) fields.push({ line: backLine(relation), notes: [] })
  const attributes: string[] = []
  if (table.primaryKey && table.primaryKey.length > 1) attributes.push(`@@id([${columnList(context, info, table.primaryKey)}])`)
  if (!table.primaryKey)
    attributes.push(
      `@@unique([${columnList(
        context,
        info,
        table.columns.map((column) => column.name),
      )}])`,
    )
  for (const unique of table.uniques.filter((item) => item.columns.length > 1))
    attributes.push(`@@unique([${columnList(context, info, unique.columns)}]${unique.name ? `, map: ${prismaString(unique.name)}` : ''})`)
  for (const index of table.indexes)
    attributes.push(`@@index([${columnList(context, info, index.columns)}]${index.name ? `, map: ${prismaString(index.name)}` : ''})`)
  attributes.push(`@@map(${prismaString(table.name)})`)
  return [
    ...(table.comment ? [`/// ${table.comment}`] : []),
    ...(!table.primaryKey
      ? [
          '/// The table has no primary key: Prisma needs a unique set of fields, so rows are told apart by all of them,',
          '/// for reading only (the tests create that unique index; the database keeps none)',
        ]
      : []),
    ...(table.schema ? [`/// TODO: the table is in the "${table.schema}" schema; enable Prisma's multiSchema and add @@schema`] : []),
    ...table.checks.map((check) => `/// CHECK (${check.sql}): Prisma does not keep CHECK constraints; the services check them`),
    `model ${info.entity} {`,
    ...aligned(fields),
    '',
    ...attributes.map((line) => `  ${line}`),
    '}',
  ]
}

export function schemaFile(context: Context): GeneratedFile {
  const provider = providerOf(context)
  const relations = relationsOf(context)
  const used = new Set(
    context.tables.flatMap((info) =>
      info.columns.map((column) => nativeEnum(context, column.column.type)).filter((item) => item !== undefined),
    ),
  )
  const enums = context.schema.enums.filter((item) => used.has(item))
  const content = lines(
    '// Prisma schema of the database, written by DB2CRUD to reflect it: the tables already exist, so do not migrate',
    '// with it. `npm install` generates the client into src/generated/prisma.',
    '',
    'generator client {',
    '  provider            = "prisma-client"',
    '  output              = "../src/generated/prisma"',
    '  moduleFormat        = "esm"',
    '  importFileExtension = "js"',
    '}',
    '',
    '// The address is in prisma.config.ts (DATABASE_URL); the application connects through src/database.ts',
    'datasource db {',
    `  provider = ${prismaString(provider)}`,
    '}',
    ...enums.flatMap((item) => ['', ...enumBlock(item)]),
    ...context.tables.flatMap((info) => ['', ...modelBlock(context, info, relations)]),
    '',
  )
  return { path: 'prisma/schema.prisma', content }
}
