/**
 * Reads SQLAlchemy models into the physical schema: declarative classes (`__tablename__`, `mapped_column` or
 * `Column`, typed `Mapped[...]` or not, `__table_args__`), association tables (`Table(...)`), indexes declared
 * after the classes, Python enums and relationships. It reads the code Model2DB writes and the usual hand-written
 * forms; anything else goes to the notes. The code says nothing about the engine: the dialect stays unknown.
 */
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbForeignKey, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { toSnakeCase } from '../../model/naming.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { PYTHON_LEXER } from '../code/python.ts'
import { booleanOf, chainOf, literalOf, nameOf, numberOf, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import type { OrmReader, SourceFile } from './types.ts'

// Splitting a module into statements

interface Statement {
  tokens: Token[]
  source: string
}

/** The statements of a block: a new one starts on a line at the block's indentation, outside any bracket. */
function statementsOf(tokens: Token[], source: string): Statement[] {
  if (tokens.length === 0) return []
  const indent = tokens[0].column
  const statements: Statement[] = []
  let current: Token[] = []
  let depth = 0
  for (const token of tokens) {
    if (token.lineStart && depth === 0 && token.column <= indent && current.length > 0) {
      statements.push({ tokens: current, source })
      current = []
    }
    current.push(token)
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth++
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1)
    }
  }
  if (current.length > 0) statements.push({ tokens: current, source })
  return statements
}

interface ClassDef {
  name: string
  bases: string[]
  body: Statement[]
  line: number
}

/** `class Name(Base, Mixin):` and the statements of its body. */
function classOf(statement: Statement): ClassDef | null {
  const cursor = new Cursor(statement.tokens)
  if (!cursor.is('class') || !cursor.isIdent(1)) return null
  cursor.next()
  const name = cursor.next().value
  const bases: string[] = []
  if (cursor.eat('(')) {
    while (!cursor.done && !cursor.is(')')) {
      const base = readExpression(cursor, statement.source)
      const text = textOf(base)
      if (text) bases.push(text)
      if (!cursor.eat(',')) break
    }
    cursor.eat(')')
  }
  cursor.eat(':')
  return { name, bases, body: statementsOf(statement.tokens.slice(cursor.index), statement.source), line: statement.tokens[0].line }
}

/** `name: Annotation = value` or `name = value`: the parts of an assignment. */
function assignmentOf(statement: Statement): { name: string; annotation: string; value: Expr | null } | null {
  const cursor = new Cursor(statement.tokens)
  if (!cursor.isIdent()) return null
  const name = cursor.next().value
  let annotation = ''
  if (cursor.eat(':')) {
    const start = cursor.index
    cursor.skipUntil(['='])
    annotation = cursor.textBetween(statement.source, start, cursor.index)
  }
  if (!cursor.eat('=')) return annotation ? { name, annotation, value: null } : null
  return { name, annotation, value: readExpression(cursor, statement.source) }
}

// Types

/** The SQLAlchemy type of a column, as a database type, or null when it is not one the rules know. */
function typeOf(expr: Expr, enums: Map<string, EnumClass>, column: string): { type: DbType; enumValues?: EnumUse } | null {
  // with_variant and the like change the type for one engine: the type is the first of the chain
  const base = chainOf(expr)[0]
  const sql = textOf(expr)
  const name = nameOf(base)?.toUpperCase() ?? ''
  const args = base.kind === 'call' ? base.args : []
  const named = base.kind === 'call' ? base.named : {}
  const length = numberOf(args[0]) ?? numberOf(named.length)
  switch (name) {
    case 'SMALLINTEGER':
    case 'SMALLINT':
      return { type: { sql, kind: 'integer', bits: 16 } }
    case 'INTEGER':
    case 'INT':
      return { type: { sql, kind: 'integer', bits: 32 } }
    case 'BIGINTEGER':
    case 'BIGINT':
      return { type: { sql, kind: 'integer', bits: 64 } }
    case 'NUMERIC':
    case 'DECIMAL': {
      const precision = numberOf(args[0]) ?? numberOf(named.precision)
      const scale = numberOf(args[1]) ?? numberOf(named.scale)
      return {
        type: { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) },
      }
    }
    case 'FLOAT':
    case 'REAL':
      return { type: { sql, kind: 'float', bits: 32 } }
    case 'DOUBLE':
    case 'DOUBLE_PRECISION':
      return { type: { sql, kind: 'float', bits: 64 } }
    case 'STRING':
    case 'VARCHAR':
    case 'UNICODE':
    case 'NVARCHAR':
      return { type: length !== undefined ? { sql, kind: 'text', length } : { sql, kind: 'text' } }
    case 'CHAR':
    case 'NCHAR':
      return { type: length !== undefined ? { sql, kind: 'text', length, fixed: true } : { sql, kind: 'text', fixed: true } }
    case 'TEXT':
    case 'UNICODETEXT':
    case 'CLOB':
      return { type: { sql, kind: 'text' } }
    case 'BOOLEAN':
      return { type: { sql, kind: 'boolean' } }
    case 'DATE':
      return { type: { sql, kind: 'date' } }
    case 'TIME':
      return { type: { sql, kind: 'time', timezone: booleanOf(named.timezone) === true } }
    case 'DATETIME':
    case 'TIMESTAMP':
      return { type: { sql, kind: 'datetime', timezone: booleanOf(named.timezone ?? args[0]) === true } }
    case 'UUID':
    case 'UUIDTYPE':
      return { type: { sql, kind: 'uuid' } }
    case 'LARGEBINARY':
    case 'BLOB':
    case 'BINARY':
    case 'VARBINARY':
    case 'BYTEA':
      return { type: length !== undefined ? { sql, kind: 'binary', length } : { sql, kind: 'binary' } }
    case 'JSON':
    case 'JSONB':
      return { type: { sql, kind: 'json' } }
    case 'ARRAY': {
      const items = args[0] ? typeOf(args[0], enums, column) : null
      return { type: { sql, kind: 'array', items: items?.type ?? { sql: '', kind: 'unknown' } } }
    }
    case 'ENUM':
      return enumTypeOf(base, sql, enums, column)
    default:
      return null
  }
}

interface EnumClass {
  name: string
  /** Member names and their values, in order */
  members: { name: string; value: string | number }[]
}

/** How a column uses an enum: its values, and whether the database keeps them in a type of its own. */
interface EnumUse {
  name: string
  values: (string | number)[]
  native: boolean
  /** A CHECK keeps the values (SQLAlchemy writes one for a non-native enum with create_constraint) */
  check: boolean
  checkName?: string
}

function enumTypeOf(expr: Expr, sql: string, enums: Map<string, EnumClass>, column: string): { type: DbType; enumValues?: EnumUse } {
  const args = expr.kind === 'call' ? expr.args : []
  const named = expr.kind === 'call' ? expr.named : {}
  const enumClass = args[0]?.kind === 'name' ? enums.get(args[0].path.at(-1)!) : undefined
  // values_callable stores the values of the members; without it SQLAlchemy stores their names
  const byValue = named.values_callable !== undefined
  const values = enumClass
    ? enumClass.members.map((member) => (byValue ? member.value : member.name))
    : args.map(literalOf).filter((value): value is string | number => value !== undefined && typeof value !== 'boolean')
  const native = booleanOf(named.native_enum) !== false
  const declared = stringOf(named.name)
  const name = enumClass ? toSnakeCase(enumClass.name) : (declared ?? `${column}_enum`)
  const use: EnumUse = {
    name: native ? (declared ?? enumClass?.name.toLowerCase() ?? name) : name,
    values,
    native,
    check: !native && booleanOf(named.create_constraint) === true,
    ...(!native && declared ? { checkName: declared } : {}),
  }
  if (native) return { type: { sql, kind: 'enum', name: use.name }, enumValues: use }
  const length = numberOf(named.length)
  return { type: length !== undefined ? { sql, kind: 'text', length } : { sql, kind: 'text' }, enumValues: use }
}

/** The database type of a column typed only by its Python annotation, as SQLAlchemy maps it. */
function typeOfAnnotation(
  annotation: string,
  enums: Map<string, EnumClass>,
  column: string,
): { type: DbType; enumValues?: EnumUse } | null {
  const inner = /Mapped\[(.*)\]/s.exec(annotation)?.[1] ?? annotation
  const python = inner
    .replace(/Optional\[(.*)\]/s, '$1')
    .replace(/\|\s*None|None\s*\|/g, '')
    .trim()
  const simple: Record<string, DbType> = {
    int: { sql: 'Integer', kind: 'integer', bits: 32 },
    str: { sql: 'String', kind: 'text' },
    float: { sql: 'Float', kind: 'float', bits: 64 },
    bool: { sql: 'Boolean', kind: 'boolean' },
    bytes: { sql: 'LargeBinary', kind: 'binary' },
    'datetime.datetime': { sql: 'DateTime', kind: 'datetime', timezone: false },
    datetime: { sql: 'DateTime', kind: 'datetime', timezone: false },
    'datetime.date': { sql: 'Date', kind: 'date' },
    date: { sql: 'Date', kind: 'date' },
    'datetime.time': { sql: 'Time', kind: 'time', timezone: false },
    'decimal.Decimal': { sql: 'Numeric', kind: 'decimal' },
    Decimal: { sql: 'Numeric', kind: 'decimal' },
    'uuid.UUID': { sql: 'Uuid', kind: 'uuid' },
    UUID: { sql: 'Uuid', kind: 'uuid' },
  }
  if (simple[python]) return { type: simple[python] }
  const enumClass = enums.get(python.split('.').at(-1)!)
  if (enumClass)
    return enumTypeOf(
      { kind: 'call', callee: { kind: 'name', path: ['Enum'] }, args: [{ kind: 'name', path: [enumClass.name] }], named: {} },
      `Enum(${enumClass.name})`,
      enums,
      column,
    )
  return null
}

const nullableByAnnotation = (annotation: string) => /\bNone\b|\bOptional\[/.test(annotation)

// Reading the module

/** What a reference to a column says before every class is known: `"customers.id"` or `Customer.id`. */
interface Reference {
  table?: string
  schema?: string
  className?: string
  column: string
}

interface PendingKey {
  key: DbForeignKey
  targets: Reference[]
  /** The columns whose type is the one of the column they reference */
  untyped?: DbColumn[]
}

interface Navigation {
  name: string
  target: string
  /** `Order.customer_id`: the attribute that holds the key */
  foreignKeys?: string
}

interface MappedTable {
  table: DbTable
  className?: string
  /** Attribute name of each column */
  attributes: Map<string, string>
  keys: PendingKey[]
  navigations: Navigation[]
}

function referenceOf(expr: Expr | undefined): Reference | null {
  const text = stringOf(expr)
  if (text !== undefined) {
    const parts = text.split('.')
    if (parts.length < 2) return null
    const column = parts.pop()!
    const table = parts.pop()!
    return { table, ...(parts.length > 0 ? { schema: parts.join('.') } : {}), column }
  }
  if (expr?.kind === 'name' && expr.path.length >= 2) return { className: expr.path.at(-2), column: expr.path.at(-1)! }
  return null
}

const ACTIONS: Record<string, DbForeignKey['onDelete']> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
}

function actionOf(expr: Expr | undefined): DbForeignKey['onDelete'] {
  const text = stringOf(expr)
  return text ? ACTIONS[text.toUpperCase()] : undefined
}

/** `ForeignKey("customers.id", ondelete="CASCADE")`, as a key waiting for its target to be known. */
function foreignKeyOf(expr: Expr, column: string): PendingKey | null {
  if (expr.kind !== 'call') return null
  const target = referenceOf(expr.args[0])
  if (!target) return null
  const onDelete = actionOf(expr.named.ondelete)
  const onUpdate = actionOf(expr.named.onupdate)
  const name = stringOf(expr.named.name)
  return {
    key: {
      ...(name ? { name } : {}),
      columns: [column],
      references: { table: '', columns: [] },
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    },
    targets: [target],
  }
}

const isNow = (expr: Expr | undefined) =>
  expr !== undefined &&
  ['now', 'current_timestamp', 'utcnow', 'localtimestamp', 'current_date', 'today'].includes(nameOf(expr)?.toLowerCase() ?? '')

const isUuid = (expr: Expr | undefined) => expr !== undefined && /^uuid[147]$|^uuid_generate_v4$|^gen_random_uuid$/.test(nameOf(expr) ?? '')

/** A default the database applies. A text is a value SQLAlchemy quotes (`server_default="0"`); `text("…")` is SQL
 * as written; `func.now()` and `true()` are what they say. */
function serverDefault(expr: Expr, column: DbColumn): void {
  const sql = expr.kind === 'call' && nameOf(expr) === 'text' ? stringOf(expr.args[0]) : undefined
  const call = expr.kind === 'call' && expr.args.length === 0 ? nameOf(expr)?.toLowerCase() : undefined
  if (isNow(expr) || (sql !== undefined && /^(now\(\)|current_timestamp(\(\))?|localtimestamp(\(\))?)$/i.test(sql.trim()))) {
    column.generated = 'now'
    return
  }
  if (isUuid(expr) || (sql !== undefined && /^(gen_random_uuid|uuid_generate_v4|uuid)\(\)$/i.test(sql.trim()))) {
    column.generated = 'uuid'
    return
  }
  if (call === 'true' || call === 'false') {
    column.default = { kind: 'literal', value: call === 'true' }
    return
  }
  const value = stringOf(expr)
  if (value !== undefined) {
    column.default = { kind: 'literal', value: literalFor(value, column.type) }
    return
  }
  if (sql === undefined) {
    column.default = { kind: 'expression', sql: textOf(expr) }
    return
  }
  const text = sql.trim()
  const quoted = /^'((?:[^']|'')*)'$/s.exec(text)
  if (quoted) column.default = { kind: 'literal', value: quoted[1].replace(/''/g, "'") }
  else if (/^-?\d+(\.\d+)?$/.test(text)) column.default = { kind: 'literal', value: Number(text) }
  else if (/^(true|false)$/i.test(text)) column.default = { kind: 'literal', value: text.toLowerCase() === 'true' }
  else column.default = { kind: 'expression', sql: text }
}

/** A quoted default as the value of the column's type: `"0"` is the number 0 for a number column. */
function literalFor(value: string, type: DbType): string | number | boolean {
  if (['integer', 'decimal', 'float'].includes(type.kind) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (type.kind === 'boolean' && /^(true|false|1|0)$/i.test(value)) return /^(true|1)$/i.test(value)
  return value
}

interface ColumnRead {
  column: DbColumn
  primaryKey: boolean
  /** null: autoincrement not said */
  autoincrement: boolean | null
  identity: boolean
  unique: boolean
  index: boolean
  key: PendingKey | null
  /** No type is written: SQLAlchemy takes the one of the column the key references */
  typeFromKey: boolean
  enumUse?: EnumUse
}

/** A column from the arguments of `mapped_column(...)` or `Column(...)`. */
function columnOf(
  call: Expr & { kind: 'call' },
  attribute: string,
  annotation: string,
  classic: boolean,
  enums: Map<string, EnumClass>,
  notes: DbNote[],
  table: string,
): ColumnRead {
  let name = attribute
  let typeExpr: Expr | undefined
  let key: PendingKey | null = null
  let identity = false
  let computed: string | undefined
  const args = [...call.args]
  if (stringOf(args[0]) !== undefined) name = stringOf(args.shift())!
  for (const arg of args) {
    const callee = nameOf(arg)
    if (callee === 'ForeignKey') key = foreignKeyOf(arg, name)
    else if (callee === 'Identity') identity = true
    else if (callee === 'Computed' && arg.kind === 'call') computed = stringOf(arg.args[0])
    else if (callee === 'Sequence') identity = true
    else if (!typeExpr) typeExpr = arg
  }
  if (call.named.type_) typeExpr = call.named.type_
  const read = typeExpr ? typeOf(typeExpr, enums, name) : typeOfAnnotation(annotation, enums, name)
  const typeFromKey = !read && !typeExpr && key !== null
  if (!read && !typeFromKey)
    notes.push({ code: 'orm.unknownType', params: { table, column: name, type: typeExpr ? textOf(typeExpr) : annotation } })
  const primaryKey = booleanOf(call.named.primary_key) === true
  const nullableSaid = booleanOf(call.named.nullable)
  // A typed attribute takes null when its annotation does; a classic Column does unless it is the key
  const nullable = nullableSaid ?? (primaryKey ? false : classic && !annotation ? true : nullableByAnnotation(annotation))
  const column: DbColumn = { name, type: read?.type ?? { sql: typeExpr ? textOf(typeExpr) : annotation, kind: 'unknown' }, nullable }
  if (computed !== undefined) column.generated = { computed }
  if (call.named.server_default) serverDefault(call.named.server_default, column)
  const value = call.named.default
  if (value && !column.generated) {
    if (isUuid(value)) column.generated = 'uuid'
    else if (isNow(value)) column.generated = 'now'
    else {
      const literal = literalOf(value)
      if (literal !== undefined) column.default = { kind: 'literal', value: enumLiteral(value, read?.enumValues, enums) ?? literal }
      else if (value.kind === 'attribute' || value.kind === 'name') {
        const member = enumLiteral(value, read?.enumValues, enums)
        if (member !== undefined) column.default = { kind: 'literal', value: member }
      }
    }
  }
  if (call.named.onupdate && isNow(call.named.onupdate)) column.generated = 'onUpdateNow'
  const comment = stringOf(call.named.comment)
  if (comment) column.comment = comment
  if (name !== attribute) column.attribute = attribute
  return {
    column,
    primaryKey,
    autoincrement: booleanOf(call.named.autoincrement) ?? null,
    identity,
    unique: booleanOf(call.named.unique) === true,
    index: booleanOf(call.named.index) === true,
    key,
    typeFromKey,
    ...(read?.enumValues ? { enumUse: read.enumValues } : {}),
  }
}

/** `OrderStatus.PAID` as the value the database keeps for it. */
function enumLiteral(expr: Expr, use: EnumUse | undefined, enums: Map<string, EnumClass>): string | number | undefined {
  if (!use || expr.kind !== 'name' || expr.path.length < 2) return undefined
  const enumClass = enums.get(expr.path.at(-2)!)
  const member = enumClass?.members.find((item) => item.name === expr.path.at(-1))
  if (!member) return undefined
  return use.values.includes(member.value) ? member.value : member.name
}

/** The table arguments: constraints, indexes and the `{"schema": …}` dictionary. */
function tableArguments(items: Expr[], mapped: MappedTable, attributeColumn: (name: string) => string): void {
  const { table } = mapped
  const names = (args: Expr[]) =>
    args
      .map((arg) => stringOf(arg) ?? (arg.kind === 'name' ? attributeColumn(arg.path.at(-1)!) : undefined))
      .filter((name): name is string => !!name)
  for (const item of items) {
    if (item.kind === 'dict') {
      for (const entry of item.entries) {
        const key = stringOf(entry.key)
        if (key === 'schema' && stringOf(entry.value)) table.schema = stringOf(entry.value)
        if (key === 'comment' && stringOf(entry.value)) table.comment = stringOf(entry.value)
      }
      continue
    }
    if (item.kind !== 'call') continue
    const name = stringOf(item.named.name)
    switch (nameOf(item)) {
      case 'UniqueConstraint':
        table.uniques.push({ ...(name ? { name } : {}), columns: names(item.args) })
        break
      case 'PrimaryKeyConstraint':
        table.primaryKey = names(item.args)
        break
      case 'CheckConstraint': {
        const sql = stringOf(item.args[0])
        if (sql) table.checks.push(checkOf(sql, name))
        break
      }
      case 'Index': {
        const indexName = stringOf(item.args[0])
        const index = { ...(indexName ? { name: indexName } : {}), columns: names(item.args.slice(1)) }
        if (booleanOf(item.named.unique)) table.uniques.push(index)
        else table.indexes.push(index)
        break
      }
      case 'ForeignKeyConstraint': {
        const columns = item.args[0]?.kind === 'list' ? names(item.args[0].items) : []
        const targets =
          item.args[1]?.kind === 'list' ? item.args[1].items.map(referenceOf).filter((ref): ref is Reference => ref !== null) : []
        const onDelete = actionOf(item.named.ondelete)
        const onUpdate = actionOf(item.named.onupdate)
        mapped.keys.push({
          key: {
            ...(name ? { name } : {}),
            columns,
            references: { table: '', columns: [] },
            ...(onDelete ? { onDelete } : {}),
            ...(onUpdate ? { onUpdate } : {}),
          },
          targets,
        })
        break
      }
    }
  }
}

function emptyTable(name: string, line: number): DbTable {
  return { name, columns: [], primaryKey: null, foreignKeys: [], uniques: [], indexes: [], checks: [], origin: { line, column: 1 } }
}

/** Adds a column and what its arguments say about the table. */
function addColumn(mapped: MappedTable, read: ColumnRead, attribute: string, enumsUsed: EnumUse[]): void {
  const { table } = mapped
  table.columns.push(read.column)
  mapped.attributes.set(attribute, read.column.name)
  if (read.unique) table.uniques.push({ columns: [read.column.name] })
  if (read.index) table.indexes.push({ columns: [read.column.name] })
  if (read.key) mapped.keys.push(read.typeFromKey ? { ...read.key, untyped: [read.column] } : read.key)
  if (read.enumUse) {
    enumsUsed.push(read.enumUse)
    if (read.enumUse.check) {
      const values = read.enumUse.values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`))
      table.checks.push(checkOf(`${read.column.name} IN (${values.join(', ')})`, read.enumUse.checkName))
    }
  }
}

/** The key and the identity of a table, once its columns are read. */
function finishKey(table: DbTable, reads: ColumnRead[]): void {
  const keyColumns = reads.filter((read) => read.primaryKey).map((read) => read.column.name)
  if (table.primaryKey === null && keyColumns.length > 0) table.primaryKey = keyColumns
  for (const read of reads) {
    if (read.column.generated) continue
    const single = table.primaryKey?.length === 1 && table.primaryKey[0] === read.column.name
    // SQLAlchemy numbers a key of one integer column unless autoincrement=False
    const numbered =
      read.identity || read.autoincrement === true || (single && read.autoincrement === null && read.column.type.kind === 'integer')
    if (numbered) read.column.generated = 'identity'
  }
}

function classTable(def: ClassDef, enums: Map<string, EnumClass>, notes: DbNote[], enumsUsed: EnumUse[]): MappedTable | null {
  const assignments = def.body.map(assignmentOf)
  const tablename = assignments.find((item) => item?.name === '__tablename__')
  const name = stringOf(tablename?.value ?? undefined)
  if (!name) return null
  const mapped: MappedTable = { table: emptyTable(name, def.line), className: def.name, attributes: new Map(), keys: [], navigations: [] }
  mapped.table.entity = def.name
  const reads: ColumnRead[] = []
  let args: Expr | undefined
  for (const item of assignments) {
    if (!item || item.name.startsWith('__')) {
      if (item?.name === '__table_args__') args = item.value ?? undefined
      continue
    }
    // `published_at: Mapped[datetime | None]` is a column with nothing more than its annotation
    const value: Expr =
      item.value ??
      (/^\s*Mapped\[/.test(item.annotation)
        ? { kind: 'call', callee: { kind: 'name', path: ['mapped_column'] }, args: [], named: {} }
        : { kind: 'other', text: '' })
    const callee = nameOf(value)
    if (value.kind === 'call' && (callee === 'mapped_column' || callee === 'Column')) {
      const read = columnOf(value, item.name, item.annotation, callee === 'Column', enums, notes, name)
      reads.push(read)
      addColumn(mapped, read, item.name, enumsUsed)
    } else if (value.kind === 'call' && callee === 'relationship' && !value.named.secondary) {
      const foreignKeys = value.named.foreign_keys
      mapped.navigations.push({
        name: item.name,
        target: targetOfRelationship(item.annotation, value),
        ...(foreignKeys
          ? { foreignKeys: stringOf(foreignKeys) ?? (foreignKeys.kind === 'list' ? textOf(foreignKeys.items[0]) : textOf(foreignKeys)) }
          : {}),
      })
    }
  }
  if (args) tableArguments(args.kind === 'list' ? args.items : [args], mapped, (attribute) => mapped.attributes.get(attribute) ?? attribute)
  finishKey(mapped.table, reads)
  return mapped
}

/** The class a relationship goes to: the first argument, or the type of its annotation. */
function targetOfRelationship(annotation: string, call: Expr & { kind: 'call' }): string {
  const named = stringOf(call.args[0]) ?? (call.args[0]?.kind === 'name' ? call.args[0].path.at(-1) : undefined)
  if (named) return named
  const inner = (/Mapped\[(.*)\]/s.exec(annotation)?.[1] ?? '').replace(/\b(Optional|list|List|set|Set)\[|["'\]]|\|\s*None/g, '')
  return /[A-Za-z_][A-Za-z0-9_]*/.exec(inner)?.[0] ?? ''
}

/** `Table("order_tags", Base.metadata, Column(...), ...)`: an association table, with no class of its own. */
function moduleTable(
  call: Expr & { kind: 'call' },
  line: number,
  enums: Map<string, EnumClass>,
  notes: DbNote[],
  enumsUsed: EnumUse[],
): MappedTable | null {
  const name = stringOf(call.args[0])
  if (!name) return null
  const mapped: MappedTable = { table: emptyTable(name, line), attributes: new Map(), keys: [], navigations: [] }
  const schema = stringOf(call.named.schema)
  if (schema) mapped.table.schema = schema
  const reads: ColumnRead[] = []
  const constraints: Expr[] = []
  for (const arg of call.args.slice(1)) {
    if (arg.kind === 'call' && nameOf(arg) === 'Column') {
      const columnName = stringOf(arg.args[0]) ?? ''
      const read = columnOf(arg, columnName, '', true, enums, notes, name)
      reads.push(read)
      addColumn(mapped, read, columnName, enumsUsed)
    } else constraints.push(arg)
  }
  tableArguments(constraints, mapped, (attribute) => attribute)
  finishKey(mapped.table, reads)
  return mapped
}

/** `class OrderStatus(enum.Enum):` and its members. */
function enumClassOf(def: ClassDef): EnumClass | null {
  if (!def.bases.some((base) => /(^|\.)(Enum|IntEnum|StrEnum)$/.test(base))) return null
  const members: EnumClass['members'] = []
  for (const statement of def.body) {
    const item = assignmentOf(statement)
    const value = literalOf(item?.value ?? undefined)
    if (item && !item.name.startsWith('_') && (typeof value === 'string' || typeof value === 'number'))
      members.push({ name: item.name, value })
  }
  return { name: def.name, members }
}

// Resolving what refers to what

function resolve(tables: MappedTable[], notes: DbNote[]): void {
  const byClass = new Map(tables.filter((item) => item.className).map((item) => [item.className!, item]))
  const columnOfClass = (className: string, attribute: string) => byClass.get(className)?.attributes.get(attribute)
  for (const mapped of tables) {
    for (const pending of mapped.keys) {
      const targets = pending.targets
      const first = targets[0]
      const target = first?.className
        ? byClass.get(first.className)?.table
        : first?.table
          ? tables.find((item) => item.table.name === first.table && (!first.schema || item.table.schema === first.schema))?.table
          : undefined
      if (!first || !target) {
        notes.push({ code: 'orm.unknownReference', params: { table: mapped.table.name, column: pending.key.columns.join(', ') } })
        continue
      }
      pending.key.references = {
        table: target.name,
        ...(target.schema ? { schema: target.schema } : {}),
        columns: targets.map((ref) => (ref.className ? (columnOfClass(ref.className, ref.column) ?? ref.column) : ref.column)),
      }
      mapped.table.foreignKeys.push(pending.key)
      pending.untyped?.forEach((column, index) => {
        const referenced = target.columns.find((item) => item.name === pending.key.references.columns[index])
        if (referenced) column.type = referenced.type
        else notes.push({ code: 'orm.unknownType', params: { table: mapped.table.name, column: column.name, type: '' } })
      })
    }
  }
  // Navigation names: the attribute of the class that holds the key, and the list on the other side
  for (const mapped of tables) {
    for (const navigation of mapped.navigations) {
      const target = byClass.get(navigation.target)
      if (!target) continue
      // The side that holds the key reads one row of the other; the other side reads the rows that point at it
      const [className, attribute] = (navigation.foreignKeys ?? '').split('.')
      const column = className ? columnOfClass(className, attribute) : undefined
      const pointsAt = (from: MappedTable, to: MappedTable) =>
        from.table.foreignKeys.find(
          (item) =>
            item.references.table === to.table.name &&
            item.references.schema === to.table.schema &&
            (!column || item.columns[0] === column),
        )
      const own = (!className || className === mapped.className) && pointsAt(mapped, target)
      if (own) {
        if (!own.attribute) own.attribute = navigation.name
        continue
      }
      const other = pointsAt(target, mapped)
      if (other && !other.inverse) other.inverse = navigation.name
    }
  }
}

/** `Index("ix_orders_customer_id_created_at", Order.customer_id, Order.created_at.desc(), unique=True)` after the classes. */
function moduleIndex(call: Expr & { kind: 'call' }, tables: MappedTable[]): void {
  const columns: string[] = []
  let owner: MappedTable | undefined
  for (const arg of call.args.slice(1)) {
    const reference = arg.kind === 'call' ? chainOf(arg)[0] : arg
    const path =
      reference.kind === 'attribute' && reference.target.kind === 'name'
        ? [...reference.target.path, reference.name]
        : reference.kind === 'name'
          ? reference.path
          : null
    if (!path || path.length < 2) continue
    owner = owner ?? tables.find((item) => item.className === path.at(-2))
    columns.push(owner?.attributes.get(path.at(-1)!) ?? path.at(-1)!)
  }
  if (!owner) return
  const name = stringOf(call.args[0])
  const index = { ...(name ? { name } : {}), columns }
  if (booleanOf(call.named.unique)) owner.table.uniques.push(index)
  else owner.table.indexes.push(index)
}

function readSqlAlchemy(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const enums = new Map<string, EnumClass>()
  const modules = files.map((file) => statementsOf(tokenize(file.text, PYTHON_LEXER), file.text))
  // Enums first: a column may name one declared further down
  const classes: ClassDef[] = []
  for (const statements of modules)
    for (const statement of statements) {
      const def = classOf(statement)
      if (!def) continue
      const enumClass = enumClassOf(def)
      if (enumClass) enums.set(enumClass.name, enumClass)
      else classes.push(def)
    }
  const tables: MappedTable[] = []
  const enumsUsed: EnumUse[] = []
  for (const def of classes) {
    const mapped = classTable(def, enums, notes, enumsUsed)
    if (mapped) tables.push(mapped)
  }
  const indexes: (Expr & { kind: 'call' })[] = []
  for (const statements of modules)
    for (const statement of statements) {
      if (statement.tokens[0]?.value === 'class') continue
      const assignment = assignmentOf(statement)
      const cursor = new Cursor(statement.tokens)
      const value = assignment?.value ?? readExpression(cursor, statement.source)
      if (value.kind !== 'call') continue
      if (nameOf(value) === 'Table') {
        const mapped = moduleTable(value, statement.tokens[0].line, enums, notes, enumsUsed)
        if (mapped) tables.push(mapped)
      } else if (nameOf(value) === 'Index') indexes.push(value)
    }
  resolve(tables, notes)
  for (const call of indexes) moduleIndex(call, tables)
  const enumList: DbEnum[] = []
  for (const use of enumsUsed)
    if (!enumList.some((item) => item.name === use.name))
      enumList.push({ name: use.name, values: use.values.map(String), storage: use.native ? 'native' : 'check' })
  return {
    format: 'db-schema',
    version: 1,
    dialect: null,
    source: { kind: 'orm', format: 'sqlalchemy' },
    tables: tables.map((item) => item.table),
    enums: enumList,
    notes,
  }
}

export const sqlalchemyReader: OrmReader = {
  id: 'sqlalchemy',
  label: 'SQLAlchemy',
  language: 'python',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    if (!/\b(from|import)\s+sqlalchemy\b/.test(text) || /\bfrom\s+sqlmodel\b/.test(text)) return 0
    return /\b(mapped_column|Column)\s*\(/.test(text) ? 1 : 0.5
  },
  read: readSqlAlchemy,
}
