/**
 * Reads Drizzle schemas into the physical schema: tables declared with `pgTable`, `mysqlTable` or `sqliteTable`
 * (also `pgSchema(…).table`), their columns as chains of calls (`bigint('id').primaryKey().notNull()`), the
 * constraints the third argument returns (`index`, `uniqueIndex`, `unique`, `primaryKey`, `foreignKey`, `check`),
 * enums (`pgEnum`, `mysqlEnum`, the `enum` option of a text column), column types of `customType`, and the navigation
 * names of `relations`. The table function names the engine.
 */
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbForeignKey, DbNote, DbSchema, DbTable, DbType, Dialect, ReferentialAction } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import { booleanOf, chainOf, literalOf, nameOf, numberOf, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import type { OrmReader, SourceFile } from './types.ts'
import { SYNTAX } from './typescript.ts'

// Reading the calls

/** The arguments of a call after its `(`, with the body of an arrow function in place of the function:
 * `(t) => [index('ix').on(t.a)]` is read as the list. A function with a block body is kept as text. */
function readCallArguments(cursor: Cursor, source: string): Expr[] {
  const args: Expr[] = []
  while (!cursor.done && !cursor.is(')')) {
    const start = cursor.index
    let arrow = false
    if (cursor.is('(')) {
      cursor.skipGroup()
      // `(t): Constraints => …`
      if (cursor.is(':')) while (!cursor.done && !cursor.is('=>') && !cursor.is(',') && !cursor.is(')')) cursor.next()
      arrow = cursor.is('=>')
    } else if (cursor.isIdent() && cursor.is('=>', 1)) {
      cursor.next()
      arrow = true
    }
    if (arrow) {
      cursor.next()
      if (cursor.is('{')) {
        const body = cursor.index
        cursor.skipGroup()
        args.push({ kind: 'other', text: cursor.textBetween(source, body, cursor.index) })
      } else args.push(readExpression(cursor, source, SYNTAX))
    } else {
      cursor.index = start
      args.push(readExpression(cursor, source, SYNTAX))
    }
    if (!cursor.eat(',')) break
  }
  cursor.eat(')')
  return args
}

const TABLES: Record<string, Dialect> = { pgTable: 'postgresql', mysqlTable: 'mysql', sqliteTable: 'sqlite' }
const SCHEMAS: Record<string, Dialect> = { pgSchema: 'postgresql', mysqlSchema: 'mysql' }
const ENUMS: Record<string, Dialect> = { pgEnum: 'postgresql' }

interface TableCall {
  variable?: string
  dialect: Dialect
  schema?: string
  args: Expr[]
  line: number
}

interface EnumCall {
  name: string
  values: string[]
}

const CUSTOM_TYPE =
  /\bconst\s+([\w$]+)\s*=\s*customType\b[\s\S]*?dataType\s*(?::\s*\([^)]*\)\s*=>\s*|\([^)]*\)\s*\{\s*return\s+)[`'"]([^`'"]+)[`'"]/g

function readCalls(files: SourceFile[]) {
  const tables: TableCall[] = []
  const relations: { variable: string; body: Expr | undefined }[] = []
  const enums = new Map<string, EnumCall>()
  const customTypes = new Map<string, string>()
  const schemas = new Map<string, { name: string; dialect: Dialect }>()
  for (const file of files) {
    for (const match of file.text.matchAll(CUSTOM_TYPE)) customTypes.set(match[1], match[2])
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, TYPESCRIPT_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    const argumentsAt = (index: number) => {
      cursor.index = index
      return readCallArguments(cursor, file.text)
    }
    const variableBefore = (index: number) =>
      tokens[index - 1]?.value === '=' && tokens[index - 2]?.kind === 'ident' ? tokens[index - 2].value : undefined
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token.kind !== 'ident') continue
      if (tokens[index + 1]?.value === '(' && tokens[index - 1]?.value !== '.') {
        if (TABLES[token.value]) {
          tables.push({ variable: variableBefore(index), dialect: TABLES[token.value], args: argumentsAt(index + 2), line: token.line })
        } else if (SCHEMAS[token.value]) {
          const variable = variableBefore(index)
          const name = stringOf(argumentsAt(index + 2)[0])
          if (variable && name) schemas.set(variable, { name, dialect: SCHEMAS[token.value] })
        } else if (ENUMS[token.value]) {
          const variable = variableBefore(index)
          const [name, values] = argumentsAt(index + 2)
          if (variable && stringOf(name) && values?.kind === 'list')
            enums.set(variable, {
              name: stringOf(name)!,
              values: values.items.map((item) => stringOf(item)).filter((item): item is string => item !== undefined),
            })
        } else if (token.value === 'relations') {
          const args = argumentsAt(index + 2)
          const variable = nameOf(args[0])
          if (variable) relations.push({ variable, body: args[1] })
        }
      } else if (tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'table' && tokens[index + 3]?.value === '(') {
        const schema = schemas.get(token.value)
        if (schema)
          tables.push({
            variable: variableBefore(index),
            dialect: schema.dialect,
            schema: schema.name,
            args: argumentsAt(index + 4),
            line: token.line,
          })
      }
    }
  }
  return { tables, relations, enums, customTypes }
}

// Types

/** The entries of an object literal, by key. */
function entriesOf(expr: Expr | undefined): Map<string, Expr> {
  const entries = new Map<string, Expr>()
  if (expr?.kind === 'dict')
    for (const entry of expr.entries) {
      const key = nameOf(entry.key) ?? stringOf(entry.key)
      if (key) entries.set(key, entry.value)
    }
  return entries
}

/** The database type of a type written in SQL (`datetime`, `varchar(20)`), for the columns of a `customType`. */
function sqlTypeOf(text: string, dialect: Dialect): DbType | null {
  const sql = text.trim()
  const match = /^([a-z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/i.exec(sql)
  if (!match) return null
  const name = match[1].toLowerCase()
  const size = match[2] !== undefined ? Number(match[2]) : undefined
  const scale = match[3] !== undefined ? Number(match[3]) : undefined
  if (/^(smallint|int2|tinyint)$/.test(name)) return { sql, kind: 'integer', bits: 16 }
  if (/^(int|integer|int4|mediumint)$/.test(name)) return { sql, kind: 'integer', bits: dialect === 'sqlite' ? 64 : 32 }
  if (/^(bigint|int8)$/.test(name)) return { sql, kind: 'integer', bits: 64 }
  if (/^(real|float4|float)$/.test(name)) return { sql, kind: 'float', bits: dialect === 'sqlite' ? 64 : 32 }
  if (/^(double|double precision|float8)$/.test(name)) return { sql, kind: 'float', bits: 64 }
  if (/^(decimal|numeric)$/.test(name))
    return { sql, kind: 'decimal', ...(size !== undefined ? { precision: size } : {}), ...(scale !== undefined ? { scale } : {}) }
  if (/^(varchar|character varying|nvarchar)$/.test(name))
    return size !== undefined ? { sql, kind: 'text', length: size } : { sql, kind: 'text' }
  if (/^(char|character|nchar)$/.test(name))
    return size !== undefined ? { sql, kind: 'text', length: size, fixed: true } : { sql, kind: 'text', fixed: true }
  if (/^(text|tinytext|mediumtext|longtext|citext|clob)$/.test(name)) return { sql, kind: 'text' }
  if (/^(boolean|bool)$/.test(name)) return { sql, kind: 'boolean' }
  if (name === 'date') return { sql, kind: 'date' }
  if (/^(time|time without time zone)$/.test(name)) return { sql, kind: 'time', timezone: false }
  if (/^(timetz|time with time zone)$/.test(name)) return { sql, kind: 'time', timezone: true }
  if (/^(datetime|timestamp|timestamp without time zone)$/.test(name)) return { sql, kind: 'datetime', timezone: false }
  if (/^(timestamptz|timestamp with time zone)$/.test(name)) return { sql, kind: 'datetime', timezone: true }
  if (/^(uuid|uniqueidentifier)$/.test(name)) return { sql, kind: 'uuid' }
  if (/^(json|jsonb)$/.test(name)) return { sql, kind: 'json' }
  if (/^(bytea|blob|binary|varbinary|longblob)$/.test(name))
    return size !== undefined ? { sql, kind: 'binary', length: size } : { sql, kind: 'binary' }
  return null
}

interface TypeRead {
  type: DbType
  /** The column is numbered by the database (`serial`) */
  identity?: boolean
  /** The values of an enum option, kept as text with a CHECK */
  values?: string[]
  /** The name of a native enum */
  enumName?: string
}

/** The type a column builder declares: `varchar('name', { length: 120 })`. */
function typeOf(
  builder: Expr & { kind: 'call' },
  dialect: Dialect,
  enums: Map<string, EnumCall>,
  customTypes: Map<string, string>,
): TypeRead | null {
  const name = nameOf(builder.callee) ?? ''
  const options = entriesOf(builder.args.find((arg) => arg.kind === 'dict'))
  const sql = textOf(builder)
  const length = numberOf(options.get('length'))
  const mode = stringOf(options.get('mode'))
  const values =
    options.get('enum')?.kind === 'list'
      ? (options.get('enum') as Expr & { kind: 'list' }).items
          .map((item) => stringOf(item))
          .filter((item): item is string => item !== undefined)
      : undefined
  const text = (fixed = false): TypeRead => ({
    type: { sql, kind: 'text', ...(length !== undefined ? { length } : {}), ...(fixed ? { fixed } : {}) },
    ...(values ? { values } : {}),
  })
  const enumCall = enums.get(name)
  if (enumCall) return { type: { sql, kind: 'enum', name: enumCall.name }, enumName: enumCall.name }
  if (name === 'mysqlEnum') {
    const list = builder.args.find((arg) => arg.kind === 'list')
    const items = list?.kind === 'list' ? list.items.map((item) => stringOf(item)).filter((item): item is string => item !== undefined) : []
    return { type: { sql, kind: 'text' }, values: items, enumName: '' }
  }
  const custom = customTypes.get(name)
  if (custom !== undefined) {
    const type = sqlTypeOf(custom, dialect)
    return type ? { type: { ...type, sql: custom } } : null
  }
  switch (name) {
    case 'smallint':
    case 'int2':
    case 'tinyint':
      return { type: { sql, kind: 'integer', bits: 16 } }
    case 'integer':
    case 'int':
      if (dialect === 'sqlite' && (mode === 'timestamp' || mode === 'timestamp_ms'))
        return { type: { sql, kind: 'datetime', timezone: false } }
      if (dialect === 'sqlite' && mode === 'boolean') return { type: { sql, kind: 'boolean' } }
      return { type: { sql, kind: 'integer', bits: dialect === 'sqlite' ? 64 : 32 } }
    case 'int4':
    case 'mediumint':
      return { type: { sql, kind: 'integer', bits: 32 } }
    case 'bigint':
    case 'int8':
      return { type: { sql, kind: 'integer', bits: 64 } }
    case 'serial':
    case 'serial4':
      return { type: { sql, kind: 'integer', bits: dialect === 'mysql' ? 64 : 32 }, identity: true }
    case 'smallserial':
    case 'serial2':
      return { type: { sql, kind: 'integer', bits: 16 }, identity: true }
    case 'bigserial':
    case 'serial8':
      return { type: { sql, kind: 'integer', bits: 64 }, identity: true }
    case 'real':
      return { type: { sql, kind: 'float', bits: dialect === 'postgresql' ? 32 : 64 } }
    case 'float':
      return { type: { sql, kind: 'float', bits: 32 } }
    case 'doublePrecision':
    case 'double':
      return { type: { sql, kind: 'float', bits: 64 } }
    case 'numeric':
    case 'decimal': {
      const precision = numberOf(options.get('precision'))
      const scale = numberOf(options.get('scale'))
      return {
        type: { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) },
      }
    }
    case 'text':
      if (dialect === 'sqlite' && mode === 'json') return { type: { sql, kind: 'json' } }
      return text()
    case 'tinytext':
    case 'mediumtext':
    case 'longtext':
    case 'varchar':
      return text()
    case 'char':
      return text(true)
    case 'boolean':
      return { type: { sql, kind: 'boolean' } }
    case 'date':
      return { type: { sql, kind: 'date' } }
    case 'time':
      return { type: { sql, kind: 'time', timezone: booleanOf(options.get('withTimezone')) === true } }
    case 'timestamp':
      return { type: { sql, kind: 'datetime', timezone: booleanOf(options.get('withTimezone')) === true } }
    case 'datetime':
      return { type: { sql, kind: 'datetime', timezone: false } }
    case 'uuid':
      return { type: { sql, kind: 'uuid' } }
    case 'json':
    case 'jsonb':
      return { type: { sql, kind: 'json' } }
    case 'blob':
      return { type: { sql, kind: mode === 'json' ? 'json' : 'binary' } as DbType }
    case 'binary':
    case 'varbinary':
    case 'bytea':
      return { type: { sql, kind: 'binary', ...(length !== undefined ? { length } : {}) } }
    default:
      return null
  }
}

const NOW_SQL = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp|\(?datetime\('now'\)\)?|\(?unixepoch\(\)\)?)$/i
const UUID_SQL = /^(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)$/i

/** The SQL of `sql\`…\`` or `sql.raw('…')`, with `${table.column}` written as the column. */
function sqlOf(expr: Expr | undefined, columnOf: (property: string) => string): string | undefined {
  if (expr?.kind !== 'call') return undefined
  const callee = expr.callee
  const isSql = (callee.kind === 'name' && callee.path[0] === 'sql') || (callee.kind === 'attribute' && nameOf(callee.target) === 'sql')
  if (!isSql) return undefined
  const text = stringOf(expr.args[0])
  return text?.replace(/\$\{\s*[\w$]+\s*\.\s*([\w$]+)\s*\}/g, (_match, property: string) => columnOf(property))
}

const ACTIONS: Record<string, ReferentialAction> = {
  cascade: 'cascade',
  'set null': 'set null',
  'set default': 'set default',
  restrict: 'restrict',
  'no action': 'no action',
}

const actionOf = (expr: Expr | undefined) => ACTIONS[(stringOf(expr) ?? '').toLowerCase()]

/** `table.column` (or `t.column`): the property it names. */
const propertyOf = (expr: Expr) => (expr.kind === 'name' && expr.path.length === 2 ? expr.path[1] : undefined)

// Building the tables

interface Model {
  call: TableCall
  table: DbTable
  /** Column of each property */
  columns: Map<string, string>
}

function readDrizzle(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const { tables: calls, relations, enums, customTypes } = readCalls(files)
  const dialects = new Set(calls.map((call) => call.dialect))
  const dialect = dialects.size === 1 ? [...dialects][0] : null
  const dbEnums: DbEnum[] = []
  const addEnum = (name: string, values: string[], storage: DbEnum['storage']) => {
    if (!dbEnums.some((item) => item.name === name)) dbEnums.push({ name, values, storage })
  }
  const models: Model[] = []
  const byVariable = new Map<string, Model>()
  // References name another table's column: resolved once every table is read
  const references: { model: Model; column: string; target: string; property: string; options: Map<string, Expr> }[] = []
  for (const call of calls) {
    const tableName = stringOf(call.args[0])
    if (!tableName) continue
    const table: DbTable = {
      name: tableName,
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      ...(call.variable ? { entity: call.variable } : {}),
      origin: { line: call.line, column: 1 },
    }
    if (call.schema) table.schema = call.schema
    const model: Model = { call, table, columns: new Map() }
    const primary: string[] = []
    const columnsArg = call.args[1]
    for (const entry of columnsArg?.kind === 'dict' ? columnsArg.entries : []) {
      const property = nameOf(entry.key) ?? stringOf(entry.key)
      if (!property) continue
      const chain = chainOf(entry.value).filter((item): item is Expr & { kind: 'call' } => item.kind === 'call')
      const builder = chain[0]
      if (!builder) continue
      const name = stringOf(builder.args[0]) ?? property
      const read = typeOf(builder, call.dialect, enums, customTypes)
      let type = read?.type ?? null
      if (read?.enumName) addEnum(read.enumName, enums.get(nameOf(builder.callee) ?? '')?.values ?? [], 'native')
      if (read?.values) {
        // `mysqlEnum` is a type of the column; the `enum` option of a text column only types it in TypeScript
        if (read.enumName === '') {
          const enumName = `${tableName}_${name}`
          addEnum(enumName, read.values, 'native')
          type = { sql: read.type.sql, kind: 'enum', name: enumName }
        } else {
          addEnum(`${tableName}_${name}`, read.values, 'check')
          table.checks.push(checkOf(`${name} IN (${read.values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')})`))
        }
      }
      if (!type)
        notes.push({ code: 'orm.unknownType', params: { table: tableName, column: name, type: nameOf(builder.callee) ?? textOf(builder) } })
      const column: DbColumn = { name, type: type ?? { sql: textOf(builder), kind: 'unknown' }, nullable: true }
      if (read?.identity) column.generated = 'identity'
      for (const modifier of chain.slice(1)) {
        const what = nameOf(modifier.callee)
        const arg = modifier.args[0]
        if (what === 'notNull') column.nullable = false
        else if (what === 'primaryKey') {
          column.nullable = false
          primary.push(name)
          if (booleanOf(entriesOf(arg).get('autoIncrement')) === true) column.generated = 'identity'
        } else if (what === 'default' && arg) {
          const sql = sqlOf(arg, (item) => model.columns.get(item) ?? item)
          if (sql !== undefined) {
            if (NOW_SQL.test(sql.trim())) column.generated = 'now'
            else if (UUID_SQL.test(sql.trim())) column.generated = 'uuid'
            else column.default = { kind: 'expression', sql }
          } else if (arg.kind === 'name' && arg.path.length === 1 && arg.path[0] === 'null')
            column.default = { kind: 'literal', value: null }
          else {
            const value = literalOf(arg)
            if (value !== undefined) column.default = { kind: 'literal', value }
            else column.default = { kind: 'expression', sql: textOf(arg) }
          }
        } else if (what === 'defaultNow') column.generated = 'now'
        else if (what === 'defaultRandom') column.generated = 'uuid'
        else if (what === 'onUpdateNow') column.generated = 'onUpdateNow'
        else if (what === 'autoincrement' || what === 'generatedAlwaysAsIdentity' || what === 'generatedByDefaultAsIdentity')
          column.generated = 'identity'
        else if (what === 'generatedAlwaysAs' && arg) {
          const sql = sqlOf(arg, (item) => model.columns.get(item) ?? item) ?? stringOf(arg)
          if (sql) column.generated = { computed: sql }
        } else if (what === 'array' && column.type.kind !== 'unknown')
          column.type = { sql: `${column.type.sql}.array()`, kind: 'array', items: column.type }
        else if (what === 'unique') {
          const uniqueName = stringOf(arg)
          table.uniques.push({ ...(uniqueName ? { name: uniqueName } : {}), columns: [name] })
        } else if (what === 'references' && arg?.kind === 'other') {
          const target = /=>\s*([\w$]+)\s*\.\s*([\w$]+)\s*$/.exec(arg.text)
          if (target) references.push({ model, column: name, target: target[1], property: target[2], options: entriesOf(modifier.args[1]) })
        }
      }
      if (name !== property) column.attribute = property
      table.columns.push(column)
      model.columns.set(property, name)
    }
    if (primary.length > 0) table.primaryKey = primary
    // SQLite numbers an INTEGER PRIMARY KEY on its own (it is the rowid)
    if (call.dialect === 'sqlite' && primary.length === 1) {
      const key = table.columns.find((item) => item.name === primary[0])!
      if (key.type.kind === 'integer' && !key.generated) key.generated = 'identity'
    }
    models.push(model)
    if (call.variable) byVariable.set(call.variable, model)
  }

  const columnOf = (model: Model, expr: Expr) => {
    const property = propertyOf(expr)
    return property !== undefined ? (model.columns.get(property) ?? property) : undefined
  }
  const listOf = (expr: Expr | undefined) => (expr?.kind === 'list' ? expr.items : [])
  for (const model of models) {
    const { table, call } = model
    const extra = call.args[2]
    const items = extra?.kind === 'list' ? extra.items : extra?.kind === 'dict' ? extra.entries.map((entry) => entry.value) : []
    for (const item of items) {
      const chain = chainOf(item).filter((part): part is Expr & { kind: 'call' } => part.kind === 'call')
      const head = chain[0]
      if (!head) continue
      const kind = nameOf(head.callee)
      const on = chain.find((part) => nameOf(part.callee) === 'on')
      const onColumns = (on?.args ?? []).map((arg) => columnOf(model, arg)).filter((column): column is string => column !== undefined)
      const name = stringOf(head.args[0])
      const named = name ? { name } : {}
      if (kind === 'index' && onColumns.length > 0) table.indexes.push({ ...named, columns: onColumns })
      else if ((kind === 'uniqueIndex' || kind === 'unique') && onColumns.length > 0) table.uniques.push({ ...named, columns: onColumns })
      else if (kind === 'primaryKey') {
        const options = entriesOf(head.args[0])
        const columns = options.has('columns') ? listOf(options.get('columns')) : head.args
        table.primaryKey = columns.map((arg) => columnOf(model, arg)).filter((column): column is string => column !== undefined)
        for (const column of table.columns) if (table.primaryKey.includes(column.name)) column.nullable = false
      } else if (kind === 'check') {
        const sql = sqlOf(head.args[1], (property) => model.columns.get(property) ?? property)
        if (sql) table.checks.push(checkOf(sql, name))
      } else if (kind === 'foreignKey') {
        const options = entriesOf(head.args[0])
        const foreign = listOf(options.get('foreignColumns'))
        const target = foreign[0]?.kind === 'name' ? byVariable.get(foreign[0].path[0]) : undefined
        if (!target) continue
        const keyName = stringOf(options.get('name'))
        const onDelete = actionOf(chain.find((part) => nameOf(part.callee) === 'onDelete')?.args[0])
        const onUpdate = actionOf(chain.find((part) => nameOf(part.callee) === 'onUpdate')?.args[0])
        table.foreignKeys.push({
          ...(keyName ? { name: keyName } : {}),
          columns: listOf(options.get('columns'))
            .map((arg) => columnOf(model, arg))
            .filter((column): column is string => column !== undefined),
          references: {
            table: target.table.name,
            ...(target.table.schema ? { schema: target.table.schema } : {}),
            columns: foreign.map((arg) => columnOf(target, arg)).filter((column): column is string => column !== undefined),
          },
          ...(onDelete ? { onDelete } : {}),
          ...(onUpdate ? { onUpdate } : {}),
        })
      }
    }
  }
  for (const reference of references) {
    const target = byVariable.get(reference.target)
    if (!target) continue
    const onDelete = actionOf(reference.options.get('onDelete'))
    const onUpdate = actionOf(reference.options.get('onUpdate'))
    reference.model.table.foreignKeys.push({
      columns: [reference.column],
      references: {
        table: target.table.name,
        ...(target.table.schema ? { schema: target.table.schema } : {}),
        columns: [target.columns.get(reference.property) ?? reference.property],
      },
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    })
  }
  applyRelations(relations, byVariable, columnOf)
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'drizzle' },
    tables: models.map((model) => model.table),
    enums: dbEnums,
    notes,
  }
}

/** The navigation names `relations` gives: `one(…, { fields })` names the foreign key of its fields, and `many(…)`
 * with the same `relationName` (or the only one between the two tables) names the other side. */
function applyRelations(
  relations: { variable: string; body: Expr | undefined }[],
  byVariable: Map<string, Model>,
  columnOf: (model: Model, expr: Expr) => string | undefined,
): void {
  const named = new Map<string, DbForeignKey>()
  const many: { model: Model; target: Model; name: string; relationName?: string }[] = []
  for (const { variable, body } of relations) {
    const model = byVariable.get(variable)
    if (!model || body?.kind !== 'dict') continue
    for (const entry of body.entries) {
      const name = nameOf(entry.key) ?? stringOf(entry.key)
      const value = entry.value
      if (!name || value.kind !== 'call') continue
      const target = byVariable.get(nameOf(value.args[0]) ?? '')
      if (!target) continue
      const options = entriesOf(value.args[1])
      const relationName = stringOf(options.get('relationName'))
      if (nameOf(value.callee) === 'many') {
        many.push({ model, target, name, ...(relationName ? { relationName } : {}) })
        continue
      }
      const fields = options.get('fields')
      const columns = (fields?.kind === 'list' ? fields.items : []).map((item) => columnOf(model, item))
      const key = model.table.foreignKeys.find(
        (item) => item.references.table === target.table.name && item.columns.join(',') === columns.join(','),
      )
      if (!key) continue
      key.attribute = name
      if (relationName) named.set(relationName, key)
    }
  }
  for (const { model, target, name, relationName } of many) {
    const candidates = target.table.foreignKeys.filter((item) => item.references.table === model.table.name)
    const key = relationName ? named.get(relationName) : candidates.length === 1 ? candidates[0] : undefined
    if (key && candidates.includes(key)) key.inverse = name
  }
}

export const drizzleReader: OrmReader = {
  id: 'drizzle',
  label: 'Drizzle',
  language: 'typescript',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /['"]drizzle-orm\/(pg|mysql|sqlite)-core['"]/.test(text) && /\b(pgTable|mysqlTable|sqliteTable|\.table)\s*\(/.test(text) ? 1 : 0
  },
  read: readDrizzle,
}
