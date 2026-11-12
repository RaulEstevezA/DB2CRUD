/**
 * `src/schema.ts`: a Drizzle table per table that reflects the database instead of designing it (exact table
 * and column names, the column types of the chosen database, keys, unique values, indexes, CHECK constraints and
 * foreign keys with their actions, and the enums the database keeps as types), and `src/column-types.ts` for
 * the types Drizzle lacks (bytes, and dates SQLite keeps as text). Drizzle never migrates with it: the database
 * already exists; the tests create their own database from it.
 */
import type { DbColumn, DbEnum, DbType } from '../../../schema/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { memberName, quote, TsImports } from '../typescript.ts'
import { columnOf, findInfo, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'

export type Dialect = 'postgresql' | 'mysql' | 'sqlite'

export function dialectOf(context: Context): Dialect {
  const database = context.settings.database
  return database === 'mysql' || database === 'mariadb' ? 'mysql' : database === 'sqlite' ? 'sqlite' : 'postgresql'
}

const CORE: Record<Dialect, { module: string; table: string }> = {
  postgresql: { module: 'drizzle-orm/pg-core', table: 'pgTable' },
  mysql: { module: 'drizzle-orm/mysql-core', table: 'mysqlTable' },
  sqlite: { module: 'drizzle-orm/sqlite-core', table: 'sqliteTable' },
}

/** Names the repositories use besides the tables: a table never takes one. */
const TAKEN = new Set([
  'and',
  'asc',
  'count',
  'eq',
  'gt',
  'isNull',
  'or',
  'sql',
  'entity',
  'row',
  'rows',
  'ids',
  'conditions',
  'total',
  'items',
  'last',
  'after',
  'limit',
  'offset',
  'error',
  'schema',
])

/** The variable of a table in src/schema.ts: `orderLines`. */
export const tableVar = (info: TableInfo) => (TAKEN.has(info.attr) ? `${info.attr}Table` : info.attr)

/** The module the tables are imported from: the project's schema, or the one the settings name. */
export function schemaModule(context: Context): string {
  return context.tables.some((info) => info.writesEntity) ? 'src/schema' : context.settings.entitiesModule.replace(/\./g, '/')
}

/** The enum of a column, when the database keeps it as a type of its own; CHECK enums stay text. */
export function nativeEnum(context: Context, type: DbType): DbEnum | undefined {
  if (type.kind !== 'enum' || dialectOf(context) === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

const enumVar = (item: DbEnum) => `${memberName(item.name)}Enum`

/** The precision written in the column's SQL type: `timestamp(3)` → 3. */
const precisionOf = (type: DbType) => /\((\d+)\)/.exec(type.sql)?.[1]

/** The column builder of a type, and the name it is imported by. */
function builderOf(context: Context, column: DbColumn, imports: TsImports): string {
  const dialect = dialectOf(context)
  const core = CORE[dialect].module
  const type = column.type
  const name = quote(column.name)
  const make = (builder: string, options?: string) => {
    imports.from(core, builder)
    return `${builder}(${name}${options ? `, ${options}` : ''})`
  }
  const custom = (builder: string, options?: string) => {
    imports.from('src/column-types', builder)
    return `${builder}(${name}${options ? `, ${options}` : ''})`
  }
  const sqlite = dialect === 'sqlite'
  const postgres = dialect === 'postgresql'
  switch (type.kind) {
    case 'integer':
      if (sqlite) return make('integer')
      if (type.bits === 64) return make('bigint', "{ mode: 'number' }")
      if (type.bits === 16) return make('smallint')
      return make(postgres ? 'integer' : 'int')
    case 'decimal': {
      const options = type.precision !== undefined ? `{ precision: ${type.precision}, scale: ${type.scale ?? 0} }` : undefined
      return sqlite ? make('numeric') : make(postgres ? 'numeric' : 'decimal', options)
    }
    case 'float':
      if (sqlite) return make('real')
      return type.bits === 32 ? make(postgres ? 'real' : 'float') : make(postgres ? 'doublePrecision' : 'double')
    case 'text':
      if (sqlite || type.length === undefined) return make('text')
      return make(type.fixed ? 'char' : 'varchar', `{ length: ${type.length} }`)
    case 'boolean':
      return sqlite ? make('integer', "{ mode: 'boolean' }") : make('boolean')
    case 'date':
      return sqlite ? make('text') : make('date', postgres ? undefined : "{ mode: 'string' }")
    case 'time': {
      if (sqlite) return make('text')
      const precision = precisionOf(type)
      const options = postgres
        ? [type.timezone && 'withTimezone: true', precision && `precision: ${precision}`]
        : [precision && `fsp: ${precision}`]
      const present = options.filter(Boolean)
      return make('time', present.length > 0 ? `{ ${present.join(', ')} }` : undefined)
    }
    case 'datetime': {
      if (sqlite) return custom('datetime')
      const precision = precisionOf(type)
      if (postgres)
        return make(
          'timestamp',
          `{ ${["mode: 'date'", type.timezone && 'withTimezone: true', precision && `precision: ${precision}`].filter(Boolean).join(', ')} }`,
        )
      return make('datetime', `{ ${["mode: 'date'", precision && `fsp: ${precision}`].filter(Boolean).join(', ')} }`)
    }
    case 'uuid':
      return sqlite ? make('text') : postgres ? make('uuid') : make('char', '{ length: 36 }')
    case 'binary':
      return custom('bytes', dialect === 'mysql' && type.length !== undefined ? `{ length: ${type.length} }` : undefined)
    case 'json':
    case 'array':
      if (sqlite) return make('text', "{ mode: 'json' }")
      return postgres && !/^json$/i.test(type.sql) ? make('jsonb') : make('json')
    case 'enum': {
      const item = nativeEnum(context, type)
      if (item && postgres) return `${enumVar(item)}(${name})`
      if (item) {
        imports.from(core, 'mysqlEnum')
        return `mysqlEnum(${name}, [${item.values.map((value) => quote(value)).join(', ')}])`
      }
      return make('text')
    }
    case 'unknown':
      return make('text')
  }
}

function defaultOf(column: DbColumn, imports: TsImports): string | null {
  const value = column.default
  if (!value) return null
  if (value.kind === 'expression') {
    imports.from('drizzle-orm', 'sql')
    return `.default(sql.raw(${quote(value.sql)}))`
  }
  const literal = value.value
  if (literal === null) return null
  if (typeof literal === 'string') {
    if (column.type.kind === 'integer' && /^-?\d+$/.test(literal)) return `.default(${literal})`
    // A date and time is written by the database from its text
    if (column.type.kind === 'datetime') {
      imports.from('drizzle-orm', 'sql')
      return `.default(sql.raw(${quote(`'${literal.replace(/'/g, "''")}'`)}))`
    }
    return `.default(${quote(literal)})`
  }
  if (typeof literal === 'number' && column.type.kind === 'decimal') return `.default(${quote(String(literal))})`
  return `.default(${String(literal)})`
}

function columnLine(context: Context, info: TableInfo, column: ColumnInfo, imports: TsImports): Line[] {
  const db = column.column
  const dialect = dialectOf(context)
  const single = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  const parts = [builderOf(context, db, imports)]
  if (single) parts.push('.primaryKey()')
  if (!db.nullable && !single) parts.push('.notNull()')
  if (db.generated === 'identity') {
    if (dialect === 'postgresql') parts.push('.generatedByDefaultAsIdentity()')
    if (dialect === 'mysql') parts.push('.autoincrement()')
    // SQLite counts up an INTEGER PRIMARY KEY by itself
  } else if (db.generated === 'uuid') {
    if (dialect === 'postgresql') parts.push('.defaultRandom()')
    else {
      imports.from('node:crypto', 'randomUUID')
      parts.push('.$defaultFn(() => randomUUID())')
    }
  } else if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    // MySQL's datetime has no defaultNow() in Drizzle
    if (dialect === 'postgresql') parts.push('.defaultNow()')
    else {
      imports.from('drizzle-orm', 'sql')
      parts.push('.default(sql`CURRENT_TIMESTAMP`)')
    }
    if (db.generated === 'onUpdateNow') parts.push('.$onUpdate(() => new Date())')
  } else if (typeof db.generated === 'object') {
    imports.from('drizzle-orm', 'sql')
    parts.push(`.generatedAlwaysAs(sql.raw(${quote(db.generated.computed)})${dialect === 'postgresql' ? '' : ", { mode: 'stored' }"})`)
  } else {
    const value = defaultOf(db, imports)
    if (value) parts.push(value)
  }
  return [
    db.comment && `  /** ${db.comment} */`,
    db.type.kind === 'unknown' && `  // TODO: "${db.type.sql}" has no Drizzle type here; it is mapped as text`,
    db.type.kind === 'array' &&
      `  // TODO: "${db.type.sql}" is mapped as JSON; use \`.array()\` on PostgreSQL if you need the native array`,
    `  ${column.prop}: ${parts.join('')},`,
  ]
}

const ACTIONS: Record<string, string> = {
  cascade: 'cascade',
  'set null': 'set null',
  'set default': 'set default',
  restrict: 'restrict',
  'no action': 'no action',
}

/** Keys, unique values, indexes, CHECK constraints and foreign keys, in the table's extra configuration. */
function constraints(context: Context, info: TableInfo, imports: TsImports): string[] {
  const core = CORE[dialectOf(context)].module
  const { table } = info
  const props = (names: string[]) => names.map((name) => `t.${columnOf(info, name).prop}`).join(', ')
  const result: string[] = []
  if (table.primaryKey && table.primaryKey.length > 1) {
    imports.from(core, 'primaryKey')
    result.push(`primaryKey({ columns: [${props(table.primaryKey)}] })`)
  }
  for (const unique of table.uniques) {
    imports.from(core, 'unique')
    result.push(`unique(${unique.name ? quote(unique.name) : ''}).on(${props(unique.columns)})`)
  }
  for (const index of table.indexes) {
    imports.from(core, 'index')
    // Drizzle names every index; the database's name when it has one
    result.push(`index(${quote(index.name ?? `${table.name}_${index.columns.join('_')}_idx`)}).on(${props(index.columns)})`)
  }
  table.checks.forEach((check, position) => {
    imports.from(core, 'check').from('drizzle-orm', 'sql')
    result.push(`check(${quote(check.name ?? `${table.name}_check_${position + 1}`)}, sql.raw(${quote(check.sql)}))`)
  })
  for (const key of table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent) continue
    imports.from(core, 'foreignKey')
    const target = parent === info ? 't' : tableVar(parent)
    const options = [
      key.name && `name: ${quote(key.name)}`,
      `columns: [${props(key.columns)}]`,
      `foreignColumns: [${key.references.columns.map((name) => `${target}.${columnOf(parent, name).prop}`).join(', ')}]`,
    ].filter(Boolean)
    result.push(
      `foreignKey({ ${options.join(', ')} })${key.onDelete ? `.onDelete('${ACTIONS[key.onDelete]}')` : ''}${key.onUpdate ? `.onUpdate('${ACTIONS[key.onUpdate]}')` : ''}`,
    )
  }
  return result
}

function tableBlock(context: Context, info: TableInfo, imports: TsImports): Line[] {
  const core = CORE[dialectOf(context)]
  imports.from(core.module, core.table)
  const columns = info.columns.flatMap((column) => columnLine(context, info, column, imports))
  const extra = constraints(context, info, imports)
  return [
    `/** The "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. */`,
    !info.table.primaryKey && '// The table has no primary key: rows are told apart by all their columns, for reading only',
    info.table.schema &&
      `// TODO: the table is in the "${info.table.schema}" schema; declare it with pgSchema("${info.table.schema}").table`,
    `export const ${tableVar(info)} = ${core.table}(`,
    `  ${quote(info.name)},`,
    '  {',
    ...columns.map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    extra.length > 0 ? '  },' : '  }',
    ...(extra.length > 0 ? ['  (t) => [', ...extra.map((item) => `    ${item},`), '  ],'] : []),
    ')',
  ]
}

export function schemaFile(context: Context): GeneratedFile {
  const imports = new TsImports('src/schema')
  const dialect = dialectOf(context)
  const used = new Set(
    context.tables.flatMap((info) =>
      info.columns.map((column) => nativeEnum(context, column.column.type)).filter((item) => item !== undefined),
    ),
  )
  const enums = dialect === 'postgresql' ? context.schema.enums.filter((item) => used.has(item)) : []
  if (enums.length > 0) imports.from(CORE.postgresql.module, 'pgEnum')
  const tables = context.tables.map((info) => tableBlock(context, info, imports))
  const content = lines(
    '/** The tables of the database, as Drizzle reads and writes them. They reflect the database: do not migrate with them. */',
    imports.write(),
    ...enums.flatMap((item) => [
      '',
      `export const ${enumVar(item)} = pgEnum(${quote(item.name)}, [${item.values.map((value) => quote(value)).join(', ')}])`,
    ]),
    ...tables.flatMap((block) => ['', ...block]),
    '',
  )
  return { path: 'src/schema.ts', content }
}

/** `src/column-types.ts`, when a column needs it: bytes, and dates SQLite keeps as text. */
export function columnTypesFile(context: Context): GeneratedFile | null {
  const dialect = dialectOf(context)
  const kinds = new Set(
    context.tables.filter((info) => info.writesEntity).flatMap((info) => info.columns.map((column) => column.column.type.kind)),
  )
  const bytes = kinds.has('binary')
  const datetime = dialect === 'sqlite' && kinds.has('datetime')
  if (!bytes && !datetime) return null
  const core = CORE[dialect].module
  const bytesType =
    dialect === 'postgresql'
      ? "  dataType: () => 'bytea',"
      : dialect === 'mysql'
        ? "  dataType: (config) => (config?.length !== undefined ? `varbinary(${config.length})` : 'blob'),"
        : "  dataType: () => 'blob',"
  return {
    path: 'src/column-types.ts',
    content: lines(
      '/** Column types Drizzle does not have for this database. */',
      `import { customType } from '${core}'`,
      bytes && [
        '',
        '/** Bytes, as a Buffer. */',
        `export const bytes = customType<{ data: Buffer; driverData: Buffer${dialect === 'mysql' ? '; config: { length?: number }' : ''} }>({`,
        bytesType,
        '})',
      ],
      datetime && [
        '',
        '/** A date and time SQLite keeps as text (`2026-01-31 12:00:00`, in UTC), as a Date. */',
        'export const datetime = customType<{ data: Date; driverData: string }>({',
        "  dataType: () => 'datetime',",
        '  toDriver: (value) => value.toISOString(),',
        "  fromDriver: (value) => new Date(/[zZ]|[+-]\\d\\d:?\\d\\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`),",
        '})',
      ],
      '',
    ),
  }
}
