/**
 * Reads TypeORM entities into the physical schema: classes marked `@Entity` (and the columns of the classes they
 * extend), their column decorators (`@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, the date and version
 * columns), the constraints of the class (`@Unique`, `@Index`, `@Check`), relations that own a foreign key
 * (`@ManyToOne`, `@OneToOne` with `@JoinColumn`), many-to-many tables (`@JoinTable`) and TypeScript enums. Names
 * nobody gave follow TypeORM's default naming strategy. The engine is the one the `DataSource` names, when it
 * names only one.
 */
import { checkOf } from '../../schema/checks.ts'
import type {
  DbColumn,
  DbEnum,
  DbForeignKey,
  DbGenerated,
  DbNote,
  DbSchema,
  DbTable,
  DbType,
  Dialect,
  ReferentialAction,
} from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import type { OrmReader, SourceFile } from './types.ts'

const SYNTAX = { named: '=' } as const

interface Decorator {
  name: string
  args: Expr[]
}

interface Member {
  name: string
  /** The TypeScript type as written: `string | null` */
  type: string
  decorators: Decorator[]
  line: number
}

interface ClassDef {
  name: string
  base?: string
  decorators: Decorator[]
  members: Member[]
  line: number
}

// Reading the declarations

function readDecorator(cursor: Cursor, source: string): Decorator {
  const parts = [cursor.next().value]
  while (cursor.is('.') && cursor.isIdent(1)) {
    cursor.next()
    parts.push(cursor.next().value)
  }
  if (!cursor.is('(')) return { name: parts.at(-1)!, args: [] }
  cursor.next()
  return { name: parts.at(-1)!, args: readArguments(cursor, source, SYNTAX, ')').args }
}

/** Moves past the rest of a statement: up to a `;`, a new line or the `}` that closes its block. */
function skipStatement(cursor: Cursor): void {
  const start = cursor.index
  while (!cursor.done) {
    const token = cursor.peek()!
    if (cursor.index > start && token.lineStart) return
    if (token.kind === 'punct' && token.value === '}') return
    if (token.kind === 'punct' && token.value === ';') {
      cursor.next()
      return
    }
    if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) cursor.skipGroup()
    else cursor.next()
  }
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'readonly',
  'declare',
  'static',
  'abstract',
  'override',
  'accessor',
  'get',
  'set',
  'async',
])

function readClassBody(cursor: Cursor, source: string): Member[] {
  const members: Member[] = []
  let decorators: Decorator[] = []
  cursor.next()
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is('@') && cursor.isIdent(1)) {
      cursor.next()
      decorators.push(readDecorator(cursor, source))
      continue
    }
    if (cursor.is(';') || cursor.is(',')) {
      cursor.next()
      continue
    }
    while (MODIFIERS.has(cursor.value()) && cursor.isIdent() && (cursor.isIdent(1) || cursor.peek(1)?.kind === 'string')) cursor.next()
    if (!cursor.isIdent() && cursor.peek()?.kind !== 'string') {
      if (cursor.is('(') || cursor.is('[') || cursor.is('{')) cursor.skipGroup()
      else cursor.next()
      decorators = []
      continue
    }
    const name = cursor.next()
    cursor.eat('!')
    cursor.eat('?')
    // `name?: Type` reads `?:` as one token
    const typed = cursor.eat(':') || cursor.eat('?:')
    if (!typed && (cursor.is('(') || cursor.is('<'))) {
      // A method: its parameters, its return type and its body
      while (!cursor.done && !cursor.is('(')) cursor.next()
      cursor.skipGroup()
      while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('}')) cursor.next()
      if (cursor.is('{')) cursor.skipGroup()
      decorators = []
      continue
    }
    let type = ''
    if (typed) {
      const start = cursor.index
      while (!cursor.done) {
        const token = cursor.peek()!
        if (cursor.index > start && token.lineStart) break
        if (token.kind === 'punct' && (token.value === ';' || token.value === '=' || token.value === '}')) break
        if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) cursor.skipGroup()
        else cursor.next()
      }
      type = cursor.textBetween(source, start, cursor.index)
    }
    if (cursor.eat('=')) skipStatement(cursor)
    members.push({ name: name.value, type, decorators, line: name.line })
    decorators = []
  }
  cursor.eat('}')
  return members
}

/** The value of each member of a TypeScript enum: a text, or a number counted on from the last one. */
type EnumDef = Map<string, string | number>

function readEnum(cursor: Cursor, source: string): EnumDef {
  const members: EnumDef = new Map()
  let next = 0
  cursor.next()
  while (!cursor.done && !cursor.is('}')) {
    if (!cursor.isIdent() && cursor.peek()?.kind !== 'string') {
      cursor.next()
      continue
    }
    const name = cursor.next().value
    if (cursor.eat('=')) {
      const value = literalOf(readExpression(cursor, source, SYNTAX))
      if (typeof value === 'number') next = value
      members.set(name, typeof value === 'string' ? value : next)
    } else members.set(name, next)
    next++
    cursor.eat(',')
  }
  cursor.eat('}')
  return members
}

function readFiles(files: SourceFile[]) {
  const classes = new Map<string, ClassDef>()
  const enums = new Map<string, EnumDef>()
  const order: ClassDef[] = []
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, TYPESCRIPT_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    let pending: Decorator[] = []
    while (!cursor.done) {
      if (cursor.is('@') && cursor.isIdent(1)) {
        cursor.next()
        pending.push(readDecorator(cursor, file.text))
      } else if (cursor.is('enum') && cursor.isIdent(1) && cursor.is('{', 2)) {
        cursor.next()
        const name = cursor.next().value
        enums.set(name, readEnum(cursor, file.text))
        pending = []
      } else if (cursor.is('class') && cursor.isIdent(1)) {
        const line = cursor.next().line
        const def: ClassDef = { name: cursor.next().value, decorators: pending, members: [], line }
        while (!cursor.done && !cursor.is('{')) {
          if (cursor.is('extends') && cursor.isIdent(1)) {
            cursor.next()
            def.base = cursor.next().value
          } else cursor.next()
        }
        def.members = readClassBody(cursor, file.text)
        classes.set(def.name, def)
        order.push(def)
        pending = []
      } else if (['export', 'default', 'abstract', 'declare', 'const'].includes(cursor.value()) && cursor.isIdent()) cursor.next()
      else {
        pending = []
        if (cursor.is('(') || cursor.is('[') || cursor.is('{')) cursor.skipGroup()
        else cursor.next()
      }
    }
  }
  return { classes, enums, order }
}

// TypeORM's default naming strategy

const snakeCase = (text: string) => text.replace(/(?:([a-z])([A-Z]))|(?:((?!^)[A-Z])([a-z]))/g, '$1_$3$2$4').toLowerCase()
const camelCase = (text: string) =>
  text.replace(/^([A-Z])|[\s\-_](\w)/g, (_match, first, next) => (next ? next.toUpperCase() : first.toLowerCase()))

// Reading the arguments

const decoratorOf = (decorators: Decorator[], ...names: string[]) => decorators.find((item) => names.includes(item.name))

/** The options of a decorator: the entries of its first object argument. */
function optionsOf(args: Expr[]): Map<string, Expr> {
  const options = new Map<string, Expr>()
  const dict = args.find((arg) => arg.kind === 'dict')
  if (dict?.kind === 'dict')
    for (const entry of dict.entries) {
      const key = nameOf(entry.key) ?? stringOf(entry.key)
      if (key) options.set(key, entry.value)
    }
  return options
}

/** `() => Order`, `(type) => Order`, `'Order'`: the class a relation points to. */
function classNameOf(expr: Expr | undefined): string | undefined {
  if (!expr) return undefined
  if (expr.kind === 'string') return expr.value
  if (expr.kind === 'name') return expr.path.at(-1)
  if (expr.kind === 'other') return /=>\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(expr.text)?.[1]
  return undefined
}

/** `(other) => other.lines` or `'lines'`: the property on the other side of a relation. */
function inverseOf(expr: Expr | undefined): string | undefined {
  if (!expr) return undefined
  if (expr.kind === 'string') return expr.value
  if (expr.kind === 'other') return /=>\s*\(?\s*[\w$]+\s*\.\s*([\w$]+)\s*\)?\s*$/.exec(expr.text)?.[1]
  return undefined
}

/** The properties a list names: `['customerId', 'createdAt']` or `(row) => [row.customerId]`. */
function propertiesOf(expr: Expr | undefined): string[] {
  if (!expr) return []
  if (expr.kind === 'list') return expr.items.map((item) => stringOf(item)).filter((item): item is string => item !== undefined)
  if (expr.kind === 'other') return [...expr.text.replace(/^[^=]*=>/, '').matchAll(/\.\s*([\w$]+)/g)].map((match) => match[1])
  return []
}

// Types

const DRIVERS: Record<string, Dialect> = {
  postgres: 'postgresql',
  'aurora-postgres': 'postgresql',
  cockroachdb: 'postgresql',
  mysql: 'mysql',
  'aurora-mysql': 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  'better-sqlite3': 'sqlite',
  sqljs: 'sqlite',
  capacitor: 'sqlite',
  cordova: 'sqlite',
  expo: 'sqlite',
  nativescript: 'sqlite',
  'react-native': 'sqlite',
  mssql: 'sqlserver',
  oracle: 'oracle',
}

const INTEGERS: Record<string, 16 | 32 | 64> = {
  smallint: 16,
  int2: 16,
  tinyint: 16,
  mediumint: 32,
  int: 32,
  integer: 32,
  int4: 32,
  bigint: 64,
  int8: 64,
}

const SIMPLE: Record<string, DbType['kind']> = {
  text: 'text',
  tinytext: 'text',
  mediumtext: 'text',
  longtext: 'text',
  ntext: 'text',
  citext: 'text',
  'simple-array': 'text',
  boolean: 'boolean',
  bool: 'boolean',
  date: 'date',
  uuid: 'uuid',
  uniqueidentifier: 'uuid',
  json: 'json',
  jsonb: 'json',
  'simple-json': 'json',
  bytea: 'binary',
  blob: 'binary',
  tinyblob: 'binary',
  mediumblob: 'binary',
  longblob: 'binary',
  image: 'binary',
}

const lengthOf = (options: Map<string, Expr>): number | undefined => {
  const value = options.get('length')
  const number = numberOf(value) ?? (stringOf(value) !== undefined ? Number(stringOf(value)) : undefined)
  return number !== undefined && Number.isFinite(number) ? number : undefined
}

/** The database type of a TypeORM column type (`varchar`, `timestamptz`…) with its options. */
function typeOfName(name: string, options: Map<string, Expr>, dialect: Dialect | null): DbType | null {
  const type = name.toLowerCase()
  const length = lengthOf(options)
  const sql = length !== undefined ? `${type}(${length})` : type
  if (INTEGERS[type]) return { sql, kind: 'integer', bits: INTEGERS[type] }
  if (type === 'float') return { sql, kind: 'float', bits: dialect === 'postgresql' || dialect === 'sqlite' ? 64 : 32 }
  if (type === 'real') return { sql, kind: 'float', bits: dialect === 'sqlite' ? 64 : 32 }
  if (type === 'float4') return { sql, kind: 'float', bits: 32 }
  if (type === 'double' || type === 'double precision' || type === 'float8') return { sql, kind: 'float', bits: 64 }
  if (type === 'decimal' || type === 'numeric' || type === 'dec') {
    const precision = numberOf(options.get('precision'))
    const scale = numberOf(options.get('scale'))
    return { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) }
  }
  if (/^(varchar|character varying|nvarchar|varchar2|nvarchar2)$/.test(type))
    return length !== undefined ? { sql, kind: 'text', length } : { sql, kind: 'text' }
  if (/^(char|character|nchar)$/.test(type))
    return length !== undefined ? { sql, kind: 'text', length, fixed: true } : { sql, kind: 'text', fixed: true }
  if (type === 'time' || type === 'time without time zone') return { sql, kind: 'time', timezone: false }
  if (type === 'timetz' || type === 'time with time zone') return { sql, kind: 'time', timezone: true }
  if (/^(timestamp|datetime|datetime2|smalldatetime|timestamp without time zone)$/.test(type))
    return { sql, kind: 'datetime', timezone: false }
  if (/^(timestamptz|timestamp with time zone|datetimeoffset)$/.test(type)) return { sql, kind: 'datetime', timezone: true }
  if (type === 'binary' || type === 'varbinary') return length !== undefined ? { sql, kind: 'binary', length } : { sql, kind: 'binary' }
  const kind = SIMPLE[type]
  return kind ? ({ sql, kind } as DbType) : null
}

/** The type TypeORM gives a column from its TypeScript type, when the decorator names none. */
function typeOfProperty(member: Member, options: Map<string, Expr>, dialect: Dialect | null): DbType | null {
  const type = member.type.replace(/\|\s*(null|undefined)\b/g, '').trim()
  if (type === 'string') return typeOfName('varchar', options, dialect)
  if (type === 'number') return typeOfName('int', options, dialect)
  if (type === 'boolean') return typeOfName('boolean', options, dialect)
  if (type === 'Date') return typeOfName('timestamp', options, dialect)
  if (type === 'Buffer' || type === 'Uint8Array') return { sql: type, kind: 'binary' }
  return null
}

const NOW_SQL = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\))$/i
const UUID_SQL = /^(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)$/i

/** A default as the database applies it: a literal, an enum member, or SQL (`() => 'CURRENT_TIMESTAMP'`). */
function applyDefault(expr: Expr, column: DbColumn, enums: Map<string, EnumDef>) {
  if (expr.kind === 'other' && expr.text.includes('=>')) {
    const body = expr.text.slice(expr.text.indexOf('=>') + 2).trim()
    const quoted = /^(['"`])([\s\S]*)\1$/.exec(body)
    const sql = quoted ? quoted[2] : body
    if (NOW_SQL.test(sql.trim())) column.generated = 'now'
    else if (UUID_SQL.test(sql.trim())) column.generated = 'uuid'
    else column.default = { kind: 'expression', sql }
    return
  }
  if (expr.kind === 'name' && expr.path.length === 1 && expr.path[0] === 'null') {
    column.default = { kind: 'literal', value: null }
    return
  }
  if (expr.kind === 'name' && expr.path.length === 2 && enums.has(expr.path[0])) {
    const value = enums.get(expr.path[0])!.get(expr.path[1])
    if (value !== undefined) column.default = { kind: 'literal', value }
    return
  }
  const value = literalOf(expr)
  if (value !== undefined) column.default = { kind: 'literal', value }
  else if (expr.kind === 'list' || expr.kind === 'dict')
    column.default = { kind: 'literal', value: JSON.stringify(JSON.parse(toJson(expr))) }
}

/** An array or object literal as JSON, for the default of a JSON column. */
function toJson(expr: Expr): string {
  if (expr.kind === 'list') return `[${expr.items.map(toJson).join(',')}]`
  if (expr.kind === 'dict')
    return `{${expr.entries.map((entry) => `${JSON.stringify(nameOf(entry.key) ?? stringOf(entry.key) ?? '')}:${toJson(entry.value)}`).join(',')}}`
  const value = literalOf(expr)
  return value === undefined ? 'null' : JSON.stringify(value)
}

const ACTIONS: Record<string, ReferentialAction> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
}

const actionOf = (expr: Expr | undefined) => ACTIONS[(stringOf(expr) ?? '').toUpperCase()]

// Building the tables

const COLUMNS = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
])

interface Model {
  def: ClassDef
  table: DbTable
  /** Column of each property */
  columns: Map<string, string>
  members: Member[]
}

function readTypeOrm(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const { classes, enums, order } = readFiles(files)
  // The engine, when the data sources name only one
  const drivers = new Set<string>()
  for (const file of files)
    for (const match of file.text.matchAll(/\b(?:DataSource|createConnection|forRoot)\s*\(\s*\{[^{}]*?\btype\s*:\s*['"]([\w-]+)['"]/g))
      drivers.add(match[1])
  for (const driver of drivers) if (!DRIVERS[driver]) notes.push({ code: 'orm.unsupportedEngine', params: { engine: driver } })
  const dialects = new Set([...drivers].map((driver) => DRIVERS[driver]).filter((item): item is Dialect => !!item))
  const dialect = dialects.size === 1 ? [...dialects][0] : null
  const nativeEnums = dialect !== 'sqlite'
  const dbEnums: DbEnum[] = []

  const membersOf = (def: ClassDef, seen = new Set<string>()): Member[] => {
    seen.add(def.name)
    const base = def.base ? classes.get(def.base) : undefined
    return [...(base && !seen.has(base.name) ? membersOf(base, seen) : []), ...def.members]
  }

  const models = new Map<string, Model>()
  const enumColumns = new Map<Model, { column: string; values: (string | number)[] }[]>()
  for (const def of order) {
    const entity = decoratorOf(def.decorators, 'Entity')
    if (!entity) continue
    const options = optionsOf(entity.args)
    const table: DbTable = {
      name: stringOf(entity.args[0]) ?? stringOf(options.get('name')) ?? snakeCase(def.name),
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: def.name,
      origin: { line: def.line, column: 1 },
    }
    const schema = stringOf(options.get('schema'))
    if (schema) table.schema = schema
    const comment = stringOf(options.get('comment'))
    if (comment) table.comment = comment
    const model: Model = { def, table, columns: new Map(), members: membersOf(def) }
    const primary: string[] = []
    const enumChecks: { column: string; values: (string | number)[] }[] = []
    for (const member of model.members) {
      const decorator = member.decorators.find((item) => COLUMNS.has(item.name))
      if (!decorator) continue
      const first = decorator.args[0]
      if (first?.kind === 'other' && first.text.includes('=>')) {
        notes.push({ code: 'orm.unknownType', params: { table: table.name, column: member.name, type: textOf(first) } })
        continue
      }
      const options = optionsOf(decorator.args)
      const name = stringOf(options.get('name')) ?? member.name
      const generated = decorator.name === 'PrimaryGeneratedColumn' ? (stringOf(first) ?? 'increment') : undefined
      const typeName = generated ? stringOf(options.get('type')) : (stringOf(first) ?? stringOf(options.get('type')))
      const enumOption = options.get('enum')
      let type: DbType | null
      if (typeName === 'enum' || typeName === 'simple-enum' || enumOption) {
        const values =
          enumOption?.kind === 'list'
            ? enumOption.items
                .map((item) => literalOf(item))
                .filter((item): item is string | number => item !== undefined && typeof item !== 'boolean')
            : enumOption?.kind === 'name'
              ? [...(enums.get(enumOption.path.at(-1)!)?.values() ?? [])]
              : enumOption?.kind === 'dict'
                ? enumOption.entries
                    .map((entry) => literalOf(entry.value))
                    .filter((item): item is string | number => item !== undefined && typeof item !== 'boolean')
                : []
        const enumName = stringOf(options.get('enumName')) ?? `${table.name}_${name}_enum`
        const native = typeName !== 'simple-enum' && nativeEnums
        if (!dbEnums.some((item) => item.name === enumName))
          dbEnums.push({ name: enumName, values: values.map(String), storage: native ? 'native' : 'check' })
        if (native) type = { sql: typeName ?? 'enum', kind: 'enum', name: enumName }
        else {
          type = { sql: typeName ?? 'simple-enum', kind: 'text' }
          const quoted = values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`))
          table.checks.push(checkOf(`${name} IN (${quoted.join(', ')})`))
        }
      } else if (generated === 'uuid') type = typeName ? typeOfName(typeName, options, dialect) : { sql: 'uuid', kind: 'uuid' }
      else if (generated) type = typeOfName(typeName ?? 'int', options, dialect)
      else if (decorator.name === 'VersionColumn' && !typeName) type = typeOfName('int', options, dialect)
      else type = typeName ? typeOfName(typeName, options, dialect) : typeOfProperty(member, options, dialect)
      // A property typed with a TypeScript enum keeps its values in a text column: an enum checked by a CHECK
      const tsEnum = member.type.replace(/\|\s*(null|undefined)\b/g, '').trim()
      if (!enumOption && type?.kind === 'text' && enums.has(tsEnum)) {
        const values = [...enums.get(tsEnum)!.values()]
        const enumName = snakeCase(tsEnum)
        if (!dbEnums.some((item) => item.name === enumName)) dbEnums.push({ name: enumName, values: values.map(String), storage: 'check' })
        enumChecks.push({ column: name, values })
      }
      if (type && booleanOf(options.get('array'))) type = { sql: `${type.sql}[]`, kind: 'array', items: type }
      if (!type) notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: typeName ?? member.type } })
      const isPrimary = decorator.name === 'PrimaryColumn' || !!generated || booleanOf(options.get('primary')) === true
      const column: DbColumn = {
        name,
        type: type ?? { sql: typeName ?? member.type, kind: 'unknown' },
        nullable: !isPrimary && (decorator.name === 'DeleteDateColumn' || booleanOf(options.get('nullable')) === true),
      }
      const value = options.get('default')
      if (value) applyDefault(value, column, enums)
      const onUpdate = stringOf(options.get('onUpdate'))
      let made: DbGenerated | undefined
      if (generated === 'uuid') made = 'uuid'
      else if (generated) made = 'identity'
      else if (decorator.name === 'CreateDateColumn') made = 'now'
      else if (decorator.name === 'UpdateDateColumn' || (onUpdate && NOW_SQL.test(onUpdate.trim()))) made = 'onUpdateNow'
      const marked = stringOf(decoratorOf(member.decorators, 'Generated')?.args[0])
      if (decoratorOf(member.decorators, 'Generated')) made = marked === 'uuid' ? 'uuid' : 'identity'
      const expression = stringOf(options.get('asExpression'))
      if (expression) made = { computed: expression }
      if (made) {
        column.generated = made
        if (made === 'now' || made === 'onUpdateNow' || made === 'uuid') delete column.default
      }
      const columnComment = stringOf(options.get('comment'))
      if (columnComment) column.comment = columnComment
      if (name !== member.name) column.attribute = member.name
      table.columns.push(column)
      model.columns.set(member.name, name)
      if (isPrimary) primary.push(name)
      if (booleanOf(options.get('unique')) === true) table.uniques.push({ columns: [name] })
      const index = decoratorOf(member.decorators, 'Index')
      if (index) {
        const indexName = stringOf(index.args[0])
        const target = booleanOf(optionsOf(index.args).get('unique')) ? table.uniques : table.indexes
        target.push({ ...(indexName ? { name: indexName } : {}), columns: [name] })
      }
    }
    if (primary.length > 0) table.primaryKey = primary
    models.set(def.name, model)
    enumColumns.set(model, enumChecks)
  }

  const columnsOf = (model: Model, expr: Expr | undefined) => propertiesOf(expr).map((name) => model.columns.get(name) ?? name)
  for (const model of models.values()) {
    const { table } = model
    for (const decorator of model.def.decorators) {
      const named = stringOf(decorator.args[0])
      const rest = named !== undefined ? decorator.args.slice(1) : decorator.args
      const name = named !== undefined ? { name: named } : {}
      if (decorator.name === 'Unique') {
        const columns = columnsOf(model, rest[0])
        if (columns.length > 0) table.uniques.push({ ...name, columns })
      } else if (decorator.name === 'Index') {
        const columns = columnsOf(model, rest[0])
        const target = booleanOf(optionsOf(decorator.args).get('unique')) ? table.uniques : table.indexes
        if (columns.length > 0) target.push({ ...name, columns })
      } else if (decorator.name === 'Check') {
        const sql = stringOf(decorator.args[1]) ?? named
        if (sql) table.checks.push(checkOf(sql, decorator.args.length > 1 ? named : undefined))
      }
    }
    // The CHECK of an enum kept as text, unless the class declares one for the column
    for (const { column, values } of enumColumns.get(model) ?? []) {
      if (table.checks.some((check) => check.parsed?.kind === 'in' && check.parsed.column === column)) continue
      const quoted = values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`))
      table.checks.push(checkOf(`${column} IN (${quoted.join(', ')})`))
    }
    // TypeORM does not create the table: its key may live only in the entity
    if (booleanOf(optionsOf(decoratorOf(model.def.decorators, 'Entity')!.args).get('synchronize')) === false)
      notes.push({ code: 'orm.unmanagedTable', params: { table: table.name } })
  }

  const joins: DbTable[] = []
  const referenced = (target: Model, property: string | undefined, position: number): DbColumn | undefined => {
    const column = property !== undefined ? (target.columns.get(property) ?? property) : target.table.primaryKey?.[position]
    return target.table.columns.find((item) => item.name === column)
  }
  for (const model of models.values()) {
    const { table } = model
    for (const member of model.members) {
      const relation = decoratorOf(member.decorators, 'ManyToOne', 'OneToOne', 'ManyToMany')
      if (!relation) continue
      const target = models.get(classNameOf(relation.args[0]) ?? '')
      if (!target) continue
      const options = optionsOf(relation.args)
      const inverse = relation.args[1]?.kind === 'dict' ? undefined : inverseOf(relation.args[1])
      if (relation.name === 'ManyToMany') {
        const joinTable = decoratorOf(member.decorators, 'JoinTable')
        if (joinTable) joins.push(joinTableOf(model, target, member, optionsOf(joinTable.args), options, referenced))
        continue
      }
      const joinColumn = decoratorOf(member.decorators, 'JoinColumn')
      if (relation.name === 'OneToOne' && !joinColumn) continue
      const joinArg = joinColumn?.args[0]
      const joinOptions: Map<string, Expr>[] =
        joinArg?.kind === 'list' ? joinArg.items.map((item) => optionsOf([item])) : joinArg ? [optionsOf([joinArg])] : []
      if (joinOptions.length === 0) for (const _ of target.table.primaryKey ?? []) joinOptions.push(new Map())
      const columns: string[] = []
      const references: string[] = []
      joinOptions.forEach((join, position) => {
        const parent = referenced(target, stringOf(join.get('referencedColumnName')), position)
        if (!parent) return
        const name = stringOf(join.get('name')) ?? camelCase(`${member.name}_${parent.name}`)
        if (!table.columns.some((item) => item.name === name)) {
          const nullable = booleanOf(options.get('nullable')) !== false && !booleanOf(options.get('primary'))
          table.columns.push({ name, type: parent.type, nullable })
          if (booleanOf(options.get('primary'))) table.primaryKey = [...(table.primaryKey ?? []), name]
        }
        columns.push(name)
        references.push(parent.name)
      })
      if (columns.length === 0) continue
      const constraint = stringOf(joinOptions[0]?.get('foreignKeyConstraintName'))
      const onDelete = actionOf(options.get('onDelete'))
      const onUpdate = actionOf(options.get('onUpdate'))
      const key: DbForeignKey = {
        ...(constraint ? { name: constraint } : {}),
        columns,
        references: { table: target.table.name, ...(target.table.schema ? { schema: target.table.schema } : {}), columns: references },
        ...(onDelete ? { onDelete } : {}),
        ...(onUpdate ? { onUpdate } : {}),
        attribute: member.name,
        ...(inverse ? { inverse } : {}),
      }
      table.foreignKeys.push(key)
      // TypeORM makes the columns of a one-to-one relation unique
      const same = (items: string[]) => items.length === columns.length && items.every((item) => columns.includes(item))
      if (relation.name === 'OneToOne' && !table.uniques.some((item) => same(item.columns)) && !same(table.primaryKey ?? []))
        table.uniques.push({ columns })
    }
  }
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'typeorm' },
    tables: [...[...models.values()].map((model) => model.table), ...joins],
    enums: dbEnums,
    notes,
  }
}

/** The table of a many-to-many relation (`@JoinTable`): its name and columns as given, or as TypeORM names them
 * (`<table>_<property>_<other table>`, with `<table>Id`-like columns), keyed by both and deleted with either row. */
function joinTableOf(
  model: Model,
  target: Model,
  member: Member,
  options: Map<string, Expr>,
  relation: Map<string, Expr>,
  referenced: (target: Model, property: string | undefined, position: number) => DbColumn | undefined,
): DbTable {
  const table: DbTable = {
    name: stringOf(options.get('name')) ?? snakeCase(`${model.table.name}_${member.name}_${target.table.name}`),
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    origin: { line: member.line, column: 1 },
  }
  const schema = stringOf(options.get('schema'))
  if (schema) table.schema = schema
  const sides = [
    [options.get('joinColumn'), model, actionOf(relation.get('onDelete')) ?? 'cascade', actionOf(relation.get('onUpdate')) ?? 'cascade'],
    [options.get('inverseJoinColumn'), target, 'cascade', 'cascade'],
  ] as const
  for (const [join, side, onDelete, onUpdate] of sides) {
    const joinOptions = join ? optionsOf([join]) : new Map<string, Expr>()
    const parent = referenced(side, stringOf(joinOptions.get('referencedColumnName')), 0)
    if (!parent) continue
    const name = stringOf(joinOptions.get('name')) ?? camelCase(`${side.table.name}_${parent.name}`)
    table.columns.push({ name, type: parent.type, nullable: false })
    table.primaryKey!.push(name)
    table.indexes.push({ columns: [name] })
    table.foreignKeys.push({
      columns: [name],
      references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [parent.name] },
      onDelete,
      onUpdate,
    })
  }
  return table
}

export const typeormReader: OrmReader = {
  id: 'typeorm',
  label: 'TypeORM',
  language: 'typescript',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\bfrom\s+['"]typeorm['"]|\brequire\(\s*['"]typeorm['"]\s*\)/.test(text) && /@Entity\s*\(/.test(text) ? 1 : 0
  },
  read: readTypeOrm,
}
