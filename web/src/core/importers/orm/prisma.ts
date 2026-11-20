/**
 * Reads a Prisma schema into the physical schema. The datasource names the engine, so the dialect is known. Models
 * are tables (`@@map`, `@@schema`), scalar fields are columns (`@map`, the native type of `@db.*`), relation fields
 * with `fields` and `references` are foreign keys, and a list on both sides with no fields is an implicit
 * many-to-many table (`_AToB`, with columns `A` and `B`). Enums are native types where the engine has them.
 *
 * Prisma keeps no CHECK constraints: they are read from the SQL of the migrations (`prisma/migrations/…/migration.sql`)
 * when those come with the schema, and a note says so when they do not. A model with no key needs a unique set of
 * fields in Prisma; a `@@unique` of all its fields is taken as that, not as a constraint of the database.
 */
import { checkOf } from '../../schema/checks.ts'
import type { DbCheck, DbColumn, DbEnum, DbForeignKey, DbNote, DbSchema, DbTable, DbType, Dialect } from '../../schema/types.ts'
import { C_LIKE, Cursor, tokenize, type Token } from '../code/lexer.ts'
import { readDdl } from '../ddl/ddl.ts'
import { literalOf, nameOf, numberOf, readArguments, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import type { OrmReader, SourceFile } from './types.ts'

const SYNTAX = { named: ':' } as const

/** `@id`, `@db.VarChar(120)`, `@@index([a, b], map: "ix")`: an attribute and its arguments. */
interface Attribute {
  name: string
  args: Expr[]
  named: Record<string, Expr>
}

interface Field {
  name: string
  type: string
  /** `Unsupported("circle")`: the arguments of the type */
  typeArgs: Expr[]
  optional: boolean
  list: boolean
  attributes: Attribute[]
  line: number
}

interface Block {
  keyword: string
  name: string
  fields: Field[]
  attributes: Attribute[]
  /** `key = value` lines of a datasource or generator */
  settings: Map<string, Expr>
  line: number
}

// Reading the declarations

/** `@name(args)` at the cursor, after its `@`. */
function readAttribute(cursor: Cursor, source: string): Attribute {
  const parts = [cursor.next().value]
  while (cursor.is('.') && cursor.isIdent(1)) {
    cursor.next()
    parts.push(cursor.next().value)
  }
  if (!cursor.is('(')) return { name: parts.join('.'), args: [], named: {} }
  cursor.next()
  const { args, named } = readArguments(cursor, source, SYNTAX, ')')
  return { name: parts.join('.'), args, named }
}

/** The tokens of each line of a block, up to its closing brace. */
function linesOf(cursor: Cursor): Token[][] {
  const lines: Token[][] = []
  let depth = 0
  while (!cursor.done) {
    const token = cursor.next()
    if (token.kind === 'punct' && depth === 0 && token.value === '}') break
    if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) depth++
    if (token.kind === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) depth--
    if (token.lineStart && depth === 0) lines.push([token])
    else if (lines.length > 0) lines.at(-1)!.push(token)
    else lines.push([token])
  }
  return lines
}

function readBlock(keyword: string, name: string, cursor: Cursor, source: string, line: number): Block {
  const block: Block = { keyword, name, fields: [], attributes: [], settings: new Map(), line }
  for (const tokens of linesOf(cursor)) {
    const inner = new Cursor(tokens)
    if (inner.is('@') && inner.is('@', 1)) {
      inner.next()
      inner.next()
      block.attributes.push(readAttribute(inner, source))
      continue
    }
    if (!inner.isIdent()) continue
    const fieldName = inner.next().value
    if (inner.eat('=')) {
      block.settings.set(fieldName, readExpression(inner, source, SYNTAX))
      continue
    }
    const field: Field = { name: fieldName, type: '', typeArgs: [], optional: false, list: false, attributes: [], line: tokens[0].line }
    if (inner.isIdent()) {
      field.type = inner.next().value
      if (inner.is('(')) {
        inner.next()
        field.typeArgs = readArguments(inner, source, SYNTAX, ')').args
      }
      if (inner.is('[') && inner.is(']', 1)) {
        inner.next()
        inner.next()
        field.list = true
      }
      if (inner.eat('?')) field.optional = true
    }
    while (!inner.done) {
      if (inner.eat('@') && inner.isIdent()) field.attributes.push(readAttribute(inner, source))
      else inner.next()
    }
    block.fields.push(field)
  }
  return block
}

function readBlocks(files: SourceFile[]): Block[] {
  const blocks: Block[] = []
  for (const file of files.filter((item) => !isSql(item))) {
    const cursor = new Cursor(tokenize(file.text, C_LIKE))
    while (!cursor.done) {
      const keyword = cursor.value()
      if (['model', 'enum', 'datasource', 'generator', 'view', 'type'].includes(keyword) && cursor.isIdent(1) && cursor.is('{', 2)) {
        const line = cursor.next().line
        const name = cursor.next().value
        cursor.next()
        blocks.push(readBlock(keyword, name, cursor, file.text, line))
      } else cursor.next()
    }
  }
  return blocks
}

// The CHECK constraints of the migrations

const isSql = (file: SourceFile) => file.name.toLowerCase().endsWith('.sql')

/** The CHECK constraints of each table, as the SQL of the migrations leaves them: read in the order of their names
 * (`prisma/migrations/<timestamp>_<name>/migration.sql`), as Prisma applies them. */
function migrationChecks(files: SourceFile[], dialect: Dialect | null): Map<string, DbCheck[]> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name))
  const schema = readDdl(sorted.map((file) => file.text).join(';\n'), dialect)
  return new Map(schema.tables.map((table) => [table.name, table.checks]))
}

// Types

const attributeOf = (attributes: Attribute[], name: string) => attributes.find((item) => item.name === name)

const DIALECTS: Record<string, Dialect> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  cockroachdb: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  sqlserver: 'sqlserver',
}

/** The database type of a scalar field, from its Prisma type and its native type (`@db.VarChar(120)`). */
function typeOf(field: Field, dialect: Dialect | null): DbType | null {
  const native = field.attributes.find((item) => item.name.startsWith('db.'))
  const nativeName = native?.name.slice(3) ?? ''
  const sql = [
    field.type,
    ...(native ? [`@${native.name}${native.args.length ? `(${native.args.map(textOf).join(', ')})` : ''}`] : []),
  ].join(' ')
  const size = numberOf(native?.args[0])
  switch (field.type) {
    case 'String':
      if (nativeName === 'Uuid' || nativeName === 'UniqueIdentifier') return { sql, kind: 'uuid' }
      if (/^(N?VarChar|VarChar2)$/.test(nativeName)) return size !== undefined ? { sql, kind: 'text', length: size } : { sql, kind: 'text' }
      if (/^N?Char$/.test(nativeName))
        return size !== undefined ? { sql, kind: 'text', length: size, fixed: true } : { sql, kind: 'text', fixed: true }
      return { sql, kind: 'text' }
    case 'Int':
      return { sql, kind: 'integer', bits: /^(SmallInt|TinyInt|UnsignedSmallInt|UnsignedTinyInt)$/.test(nativeName) ? 16 : 32 }
    case 'BigInt':
      return { sql, kind: 'integer', bits: 64 }
    case 'Float':
      return { sql, kind: 'float', bits: nativeName === 'Real' || (nativeName === 'Float' && dialect === 'mysql') ? 32 : 64 }
    case 'Decimal': {
      const scale = numberOf(native?.args[1])
      return { sql, kind: 'decimal', ...(size !== undefined ? { precision: size } : {}), ...(scale !== undefined ? { scale } : {}) }
    }
    case 'Boolean':
      return { sql, kind: 'boolean' }
    case 'DateTime':
      if (nativeName === 'Date') return { sql, kind: 'date' }
      if (nativeName === 'Time' || nativeName === 'Timetz') return { sql, kind: 'time', timezone: nativeName === 'Timetz' }
      return { sql, kind: 'datetime', timezone: nativeName === 'Timestamptz' || nativeName === 'DateTimeOffset' }
    case 'Json':
      return { sql, kind: 'json' }
    case 'Bytes':
      return { sql, kind: 'binary' }
    default:
      return null
  }
}

// Building the tables

interface EnumInfo {
  /** The name of the type in the database (`@@map`) */
  sqlName: string
  /** The value the database keeps for each member (`@map`) */
  values: Map<string, string>
}

const ACTIONS: Record<string, DbForeignKey['onDelete']> = {
  Cascade: 'cascade',
  Restrict: 'restrict',
  NoAction: 'no action',
  SetNull: 'set null',
  SetDefault: 'set default',
}

/** A default as the database applies it, or as Prisma fills it in. */
function applyDefault(expr: Expr, column: DbColumn, enumInfo: EnumInfo | undefined): void {
  const call = expr.kind === 'call' ? nameOf(expr) : undefined
  if (call === 'autoincrement' || call === 'sequence') column.generated = 'identity'
  else if (call === 'now') column.generated = 'now'
  else if (call && ['uuid', 'cuid', 'nanoid', 'ulid'].includes(call)) column.generated = 'uuid'
  else if (call === 'dbgenerated' && expr.kind === 'call') {
    const sql = stringOf(expr.args[0]) ?? ''
    if (/^(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)$/i.test(sql.trim())) column.generated = 'uuid'
    else if (/^(now\(\)|current_timestamp(\(\))?)$/i.test(sql.trim())) column.generated = 'now'
    else if (sql) column.default = { kind: 'expression', sql }
  } else if (expr.kind === 'name' && expr.path.length === 1 && enumInfo?.values.has(expr.path[0]))
    column.default = { kind: 'literal', value: enumInfo.values.get(expr.path[0])! }
  else {
    const value = literalOf(expr)
    if (value !== undefined) column.default = { kind: 'literal', value }
    else if (expr.kind === 'list') column.default = { kind: 'expression', sql: textOf(expr) }
  }
}

interface Model {
  block: Block
  table: DbTable
  /** Column of each scalar field */
  columns: Map<string, string>
}

/** The fields a list names: `[customerId, createdAt(sort: Desc)]`. */
const fieldNames = (expr: Expr | undefined): string[] =>
  expr?.kind === 'list' ? expr.items.map((item) => nameOf(item)).filter((name): name is string => !!name) : []

function readPrisma(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const blocks = readBlocks(files)
  const provider = stringOf(blocks.find((block) => block.keyword === 'datasource')?.settings.get('provider'))
  const dialect = provider ? (DIALECTS[provider] ?? null) : null
  if (provider && !DIALECTS[provider]) notes.push({ code: 'orm.unsupportedEngine', params: { engine: provider } })
  const nativeEnums = dialect === 'postgresql' || dialect === 'mysql'
  const enumInfos = new Map<string, EnumInfo>()
  const enums: DbEnum[] = []
  for (const block of blocks.filter((item) => item.keyword === 'enum')) {
    const values = new Map(block.fields.map((field) => [field.name, stringOf(attributeOf(field.attributes, 'map')?.args[0]) ?? field.name]))
    const sqlName = stringOf(attributeOf(block.attributes, 'map')?.args[0]) ?? block.name
    enumInfos.set(block.name, { sqlName, values })
    enums.push({ name: sqlName, values: [...values.values()], storage: nativeEnums ? 'native' : 'check' })
  }
  const modelBlocks = blocks.filter((block) => block.keyword === 'model')
  const models = new Map<string, Model>()
  for (const block of modelBlocks) {
    const table: DbTable = {
      name: stringOf(attributeOf(block.attributes, 'map')?.args[0]) ?? block.name,
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: block.name,
      origin: { line: block.line, column: 1 },
    }
    const schema = stringOf(attributeOf(block.attributes, 'schema')?.args[0])
    if (schema) table.schema = schema
    const model: Model = { block, table, columns: new Map() }
    for (const field of block.fields) {
      const enumInfo = enumInfos.get(field.type)
      const relation = modelBlocks.some((item) => item.name === field.type)
      if (relation) continue
      const name = stringOf(attributeOf(field.attributes, 'map')?.args[0]) ?? field.name
      let type: DbType | null
      if (enumInfo) {
        type = nativeEnums ? { sql: field.type, kind: 'enum', name: enumInfo.sqlName } : { sql: field.type, kind: 'text' }
        if (!nativeEnums) {
          const values = [...enumInfo.values.values()].map((value) => `'${value.replace(/'/g, "''")}'`)
          table.checks.push(checkOf(`${name} IN (${values.join(', ')})`))
        }
      } else type = typeOf(field, dialect)
      if (type && field.list) type = { sql: `${field.type}[]`, kind: 'array', items: type }
      if (!type) notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: field.type } })
      const column: DbColumn = {
        name,
        type: type ?? { sql: [field.type, ...field.typeArgs.map(textOf)].join(' '), kind: 'unknown' },
        nullable: field.optional,
      }
      const value = attributeOf(field.attributes, 'default')?.args[0]
      if (value) applyDefault(value, column, enumInfo)
      if (attributeOf(field.attributes, 'updatedAt')) column.generated = 'onUpdateNow'
      if (name !== field.name) column.attribute = field.name
      table.columns.push(column)
      model.columns.set(field.name, name)
      if (attributeOf(field.attributes, 'id')) table.primaryKey = [name]
      const unique = attributeOf(field.attributes, 'unique')
      if (unique) {
        const map = stringOf(unique.named.map)
        table.uniques.push({ ...(map ? { name: map } : {}), columns: [name] })
      }
    }
    models.set(block.name, model)
  }
  const columnsOf = (model: Model, expr: Expr | undefined) => fieldNames(expr).map((field) => model.columns.get(field) ?? field)
  for (const model of models.values()) {
    const { table, block } = model
    for (const attribute of block.attributes) {
      const fields = attribute.args[0] ?? attribute.named.fields
      const map = stringOf(attribute.named.map) ?? stringOf(attribute.named.name)
      if (attribute.name === 'id') table.primaryKey = columnsOf(model, fields)
      else if (attribute.name === 'unique') table.uniques.push({ ...(map ? { name: map } : {}), columns: columnsOf(model, fields) })
      else if (attribute.name === 'index') table.indexes.push({ ...(map ? { name: map } : {}), columns: columnsOf(model, fields) })
    }
  }
  for (const model of models.values()) {
    const { table } = model
    // Prisma needs a unique set of fields on a table with no key: one of all its fields is only that
    const all = [...model.columns.values()].sort().join(',')
    const ormOnly = table.primaryKey ? -1 : table.uniques.findIndex((item) => [...item.columns].sort().join(',') === all)
    if (ormOnly >= 0) {
      table.uniques.splice(ormOnly, 1)
      notes.push({ code: 'orm.ormOnlyUnique', params: { table: table.name } })
    }
  }
  const sqlFiles = files.filter(isSql)
  if (sqlFiles.length > 0) {
    const checks = migrationChecks(sqlFiles, dialect)
    for (const model of models.values()) model.table.checks.push(...(checks.get(model.table.name) ?? []))
  } else if (models.size > 0) notes.push({ code: 'orm.checksNotKept' })
  const joins: DbTable[] = []
  for (const model of models.values()) {
    for (const field of model.block.fields) {
      const target = models.get(field.type)
      if (!target) continue
      const relation = attributeOf(field.attributes, 'relation')
      const relationName = stringOf(relation?.args[0]) ?? stringOf(relation?.named.name)
      const sameRelation = (other: Field) => {
        const otherName =
          stringOf(attributeOf(other.attributes, 'relation')?.args[0]) ?? stringOf(attributeOf(other.attributes, 'relation')?.named.name)
        return other.type === model.block.name && otherName === relationName && other !== field
      }
      const inverse = target.block.fields.find(sameRelation)
      const columns = columnsOf(model, relation?.named.fields)
      if (columns.length > 0) {
        const references = columnsOf(target, relation?.named.references)
        const onDelete =
          ACTIONS[nameOf(relation?.named.onDelete) ?? ''] ??
          (columns.every((column) => model.table.columns.find((item) => item.name === column)?.nullable) ? 'set null' : 'restrict')
        const onUpdate = ACTIONS[nameOf(relation?.named.onUpdate) ?? '']
        const map = stringOf(relation?.named.map)
        model.table.foreignKeys.push({
          ...(map ? { name: map } : {}),
          columns,
          references: { table: target.table.name, ...(target.table.schema ? { schema: target.table.schema } : {}), columns: references },
          onDelete,
          ...(onUpdate ? { onUpdate } : {}),
          attribute: field.name,
          ...(inverse ? { inverse: inverse.name } : {}),
        })
      } else if (field.list && inverse?.list && model.block.name <= target.block.name && (model !== target || field.name < inverse.name)) {
        joins.push(implicitJoin(model, target, relationName, field.line))
      }
    }
  }
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'prisma' },
    tables: [...[...models.values()].map((model) => model.table), ...joins],
    enums,
    notes,
  }
}

/** The table Prisma creates for a many-to-many relation with no model: `_<A>To<B>` (or `_<relation name>`), with a
 * column `A` to the model first in alphabetical order and `B` to the other. */
function implicitJoin(first: Model, second: Model, relationName: string | undefined, line: number): DbTable {
  const table: DbTable = {
    name: `_${relationName ?? `${first.block.name}To${second.block.name}`}`,
    columns: [],
    primaryKey: ['A', 'B'],
    foreignKeys: [],
    uniques: [],
    indexes: [{ columns: ['B'] }],
    checks: [],
    origin: { line, column: 1 },
  }
  for (const [column, side] of [
    ['A', first],
    ['B', second],
  ] as const) {
    const key = side.table.primaryKey?.[0] ?? 'id'
    const referenced = side.table.columns.find((item) => item.name === key)
    table.columns.push({ name: column, type: referenced?.type ?? { sql: '', kind: 'unknown' }, nullable: false })
    table.foreignKeys.push({
      columns: [column],
      references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [key] },
      onDelete: 'cascade',
      onUpdate: 'cascade',
    })
  }
  return table
}

export const prismaReader: OrmReader = {
  id: 'prisma',
  label: 'Prisma',
  language: 'prisma',
  detect(files) {
    if (files.some((file) => file.name.endsWith('.prisma'))) return 1
    const text = files.map((file) => file.text).join('\n')
    return /^\s*(datasource|generator)\s+\w+\s*\{/m.test(text) || /^\s*model\s+\w+\s*\{[^}]*@(id|relation|map)\b/m.test(text) ? 1 : 0
  },
  read: readPrisma,
}
