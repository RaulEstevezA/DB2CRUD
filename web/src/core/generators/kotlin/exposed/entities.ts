/**
 * The entity of each table (a class with a property per column, every one of them null until it is set) and its
 * Exposed table object, which describes the table as the database has it: exact table and column names, types with
 * their lengths and precision, the key, unique values, indexes, foreign keys with their actions, defaults and the
 * values the database fills. Exposed reads and writes rows through the table object; the repositories turn rows
 * into entities and back. CHECK constraints are named in the table's comment: the services check them.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { typeSql } from '../../../schema/ddl.ts'
import type { DbColumn, DbEnum, DbType } from '../../../schema/types.ts'
import {
  columnOf,
  commonPackage,
  findInfo,
  ktFile,
  optionalType,
  packageOf,
  pathOf,
  qualified,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from '../context.ts'
import { KtImports, ktString } from '../kotlin.ts'
import { ktLiteral } from '../repositories.ts'

const EXPOSED = 'org.jetbrains.exposed.v1.core'
const JAVA_TIME = 'org.jetbrains.exposed.v1.javatime'

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new KtImports(pkg)
  for (const column of info.columns) if (column.ktImport) imports.add(column.ktImport)
  return ktFile(pathOf(pkg, info.entity), pkg, imports.write(), [
    `/** A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. Its mapping is ${info.tableObject}; a property stays null until it is set or read. */`,
    `class ${info.entity}(`,
    ...info.columns.map((column) => `    var ${column.prop}: ${optionalType(column)} = null,`),
    ')',
  ])
}

/** The enum of the database a column holds, when the database keeps it as a type of its own. */
export function nativeEnum(context: Context, column: DbColumn): DbEnum | undefined {
  const type = column.type
  if (type.kind !== 'enum' || context.settings.database === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

/** Whether a table object uses the column type of the enums of the database. */
export const usesEnumColumns = (context: Context) =>
  context.tables.some((info) => info.writesEntity && info.columns.some((column) => nativeEnum(context, column.column)))

const isMySql = (context: Context) => context.settings.database === 'mysql' || context.settings.database === 'mariadb'

const usesColumn = (context: Context, test: (column: DbColumn) => boolean) =>
  context.tables.some((info) => info.writesEntity && info.columns.some((column) => test(column.column)))

/** Whether a table object uses the column type of the values PostgreSQL keeps in a type Exposed does not have. */
export const usesNativeText = (context: Context) =>
  context.settings.database === 'postgresql' && usesColumn(context, ({ type }) => ['json', 'array', 'unknown'].includes(type.kind))

/** Whether a table object uses the column type of MySQL's bytes without a length. */
const usesLongBinary = (context: Context) =>
  isMySql(context) && usesColumn(context, ({ type }) => type.kind === 'binary' && type.length === undefined)

const quoteSql = (text: string) => `'${text.replace(/'/g, "''")}'`

/** The Exposed call that registers a column, without its modifiers. */
function columnCall(context: Context, column: ColumnInfo, imports: KtImports): string {
  const db = column.column
  const name = ktString(db.name)
  const type: DbType = db.type
  const enumType = nativeEnum(context, db)
  if (enumType) {
    imports.add(qualified(commonPackage(context), 'databaseEnum'))
    const sql = context.settings.database === 'postgresql' ? `"${enumType.name}"` : `ENUM(${enumType.values.map(quoteSql).join(', ')})`
    return `databaseEnum(${name}, ${ktString(sql)}${context.settings.database === 'postgresql' ? `, ${ktString(enumType.name)}` : ''})`
  }
  switch (type.kind) {
    case 'integer':
      return `${type.bits === 16 ? 'short' : type.bits === 64 ? 'long' : 'integer'}(${name})`
    case 'decimal':
      return `decimal(${name}, ${type.precision ?? 10}, ${type.scale ?? 0})`
    case 'float':
      return `${type.bits === 32 ? 'float' : 'double'}(${name})`
    case 'text':
      if (type.length === undefined) return `text(${name})`
      return `${type.fixed ? 'char' : 'varchar'}(${name}, ${type.length})`
    case 'boolean':
      return `bool(${name})`
    case 'date':
      imports.add(`${JAVA_TIME}.date`)
      return `date(${name})`
    case 'time':
      imports.add(`${JAVA_TIME}.time`)
      return `time(${name})`
    case 'datetime': {
      const call = !type.timezone ? 'datetime' : context.settings.database === 'mariadb' ? 'timestamp' : 'timestampWithTimeZone'
      imports.add(`${JAVA_TIME}.${call}`)
      return `${call}(${name})`
    }
    case 'uuid':
      imports.add(`${EXPOSED}.java.javaUUID`)
      return `javaUUID(${name})`
    case 'binary':
      if (type.length === undefined && isMySql(context)) {
        imports.add(qualified(commonPackage(context), 'longBinary'))
        return `longBinary(${name})`
      }
      return type.length !== undefined ? `binary(${name}, ${type.length})` : `binary(${name})`
    case 'enum': {
      // An enum kept with a CHECK: its text, as long as its longest value
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      const length = Math.max(1, ...values.map((value) => value.length))
      return `varchar(${name}, ${length})`
    }
    case 'json':
    case 'array':
    case 'unknown':
      if (context.settings.database === 'postgresql') {
        imports.add(qualified(commonPackage(context), 'nativeText'))
        return `nativeText(${name}, ${ktString(typeSql(context.schema, 'postgresql', type))})`
      }
      return `text(${name})`
  }
}

const NOW: Record<string, string> = {
  LocalDate: 'CurrentDate',
  LocalDateTime: 'CurrentDateTime',
  OffsetDateTime: 'CurrentTimestampWithTimeZone',
  Instant: 'CurrentTimestamp',
}

/** The modifiers of a column: what the database fills, its default, null. */
function modifiers(context: Context, info: TableInfo, column: ColumnInfo, imports: KtImports, todo: string[]): string {
  const db = column.column
  const calls: string[] = []
  const single = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  if (db.generated === 'identity') {
    if (single) calls.push('.autoIncrement()')
    else {
      calls.push('.databaseGenerated()')
      todo.push('// TODO: the database numbers this column; Exposed numbers only a key of one column')
    }
  } else if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    const now = NOW[column.kt]
    if (now) {
      imports.add(`${JAVA_TIME}.${now}`)
      calls.push(`.defaultExpression(${now})`)
    } else calls.push('.databaseGenerated()')
    if (db.generated === 'onUpdateNow') todo.push('// TODO: the database sets it again on every change; Exposed only reads it')
  } else if (typeof db.generated === 'object') {
    calls.push('.databaseGenerated()', `.withDefinition(${ktString(`GENERATED ALWAYS AS (${db.generated.computed}) STORED`)})`)
  } else if (db.default?.kind === 'literal' && db.default.value !== null) {
    if (column.ktImport) imports.add(column.ktImport)
    calls.push(`.default(${ktLiteral(column, db.default.value)})`)
  } else if (db.default?.kind === 'expression') {
    calls.push('.databaseGenerated()', `.withDefinition(${ktString(`DEFAULT ${db.default.sql}`)})`)
    todo.push(`// TODO: the database fills it with ${db.default.sql} on insert; Exposed never sends a value for it`)
  }
  if (db.comment && context.settings.database !== 'sqlite') calls.push(`.comment(${ktString(db.comment)})`)
  // Last: the defaults above are of the column's own type
  if (db.nullable) calls.push('.nullable()')
  return calls.join('')
}

const ACTIONS: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET_NULL',
  'set default': 'SET_DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'NO_ACTION',
}

export function tableObjectFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new KtImports(pkg).add(`${EXPOSED}.Table`)
  const { table } = info
  const columnLines = info.columns.flatMap((column) => {
    const todo: string[] = []
    const call = columnCall(context, column, imports)
    const mods = modifiers(context, info, column, imports, todo)
    return [...todo, `val ${column.prop} = ${call}${mods}`]
  })
  const members = (names: string[]) => names.map((name) => columnOf(info, name).prop).join(', ')
  const constraints: string[] = []
  for (const unique of table.uniques)
    constraints.push(`uniqueIndex(${unique.name ? ktString(unique.name) : 'null'}, ${members(unique.columns)})`)
  for (const index of table.indexes)
    constraints.push(`index(${index.name ? ktString(index.name) : 'null'}, false, ${members(index.columns)})`)
  for (const key of table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent) {
      constraints.push(`// TODO: ${key.columns.join(', ')} points to ${key.references.table}, a table this project does not have`)
      continue
    }
    if (parent !== info && parent.writesEntity !== info.writesEntity) continue
    if (parent !== info && packageOf(context, parent, 'entity') !== pkg)
      imports.add(qualified(packageOf(context, parent, 'entity'), parent.tableObject))
    const pairs = key.columns
      .map((name, position) => {
        const target = columnOf(parent, key.references.columns[position]).prop
        return `${columnOf(info, name).prop} to ${parent === info ? target : `${parent.tableObject}.${target}`}`
      })
      .join(', ')
    const args = [pairs]
    if (key.onDelete) {
      imports.add(`${EXPOSED}.ReferenceOption`)
      args.push(`onDelete = ReferenceOption.${ACTIONS[key.onDelete]}`)
    }
    if (key.name) args.push(`name = ${ktString(key.name)}`)
    constraints.push(`foreignKey(${args.join(', ')})`)
  }
  const checks = table.checks.map((check) => ` * CHECK (${check.sql}): the services check what they understand of it.`)
  const tableName = table.schema ? `${table.schema}.${table.name}` : table.name
  return ktFile(pathOf(pkg, info.tableObject), pkg, imports.write(), [
    '/**',
    ` * The "${table.name}" table, as the database has it. Exposed never creates or changes it: the database already exists.`,
    ...(checks.length > 0 ? [' *', ...checks] : []),
    ...(table.primaryKey ? [] : [' *', ' * It has no primary key: its rows are told apart by all their columns.']),
    ' */',
    `object ${info.tableObject} : Table(${ktString(tableName)}) {`,
    ...columnLines.map((line) => `    ${line}`),
    ...(table.primaryKey ? ['', `    override val primaryKey = PrimaryKey(${members(table.primaryKey)})`] : []),
    ...(constraints.length > 0 ? ['', '    init {', ...constraints.map((line) => `        ${line}`), '    }'] : []),
    '}',
  ])
}

/** `DatabaseEnum.kt`: the column type of an enum the database keeps as a type of its own; the entities keep its text. */
export function enumColumnFile(context: Context): GeneratedFile | null {
  if (!usesEnumColumns(context)) return null
  const pkg = commonPackage(context)
  const postgres = context.settings.database === 'postgresql'
  const imports = new KtImports(pkg).add(`${EXPOSED}.Column`, `${EXPOSED}.Table`, `${EXPOSED}.VarCharColumnType`)
  if (postgres) imports.add('org.postgresql.util.PGobject')
  return ktFile(pathOf(pkg, 'DatabaseEnum'), pkg, imports.write(), [
    '/** A value of an enum of the database, kept as its text. */',
    `class DatabaseEnumColumnType(private val sql: String${postgres ? ', private val typeName: String' : ''}) : VarCharColumnType() {`,
    '    override fun sqlType(): String = sql',
    ...(postgres
      ? [
          '',
          '    // PostgreSQL takes a value of the enum, not a text',
          '    override fun notNullValueToDB(value: String): Any = PGobject().also {',
          '        it.type = typeName',
          '        it.value = value',
          '    }',
          '',
          '    override fun valueFromDB(value: Any): String = if (value is PGobject) value.value!! else value.toString()',
        ]
      : []),
    '}',
    '',
    '/** A column of an enum of the database. */',
    `fun Table.databaseEnum(name: String, sql: String${postgres ? ', typeName: String' : ''}): Column<String> =`,
    `    registerColumn(name, DatabaseEnumColumnType(sql${postgres ? ', typeName' : ''}))`,
  ])
}

/** `NativeText.kt`: the column type of a value kept as its text that PostgreSQL has in a type of its own (json, arrays…). */
export function nativeTextFile(context: Context): GeneratedFile | null {
  if (!usesNativeText(context)) return null
  const pkg = commonPackage(context)
  const imports = new KtImports(pkg).add(
    `${EXPOSED}.Column`,
    `${EXPOSED}.Table`,
    `${EXPOSED}.TextColumnType`,
    'org.postgresql.util.PGobject',
  )
  return ktFile(pathOf(pkg, 'NativeText'), pkg, imports.write(), [
    '/** A value kept as its text, in a column of another type of PostgreSQL. */',
    'class NativeTextColumnType(private val sql: String) : TextColumnType() {',
    '    override fun sqlType(): String = sql',
    '',
    '    // Of no type yet: PostgreSQL gives it the type of the column',
    '    override fun notNullValueToDB(value: String): Any = PGobject().also {',
    '        it.type = "unknown"',
    '        it.value = value',
    '    }',
    '',
    '    override fun valueFromDB(value: Any): String = if (value is PGobject) value.value!! else value.toString()',
    '}',
    '',
    '/** A column of a type Exposed does not have, read and written as text. */',
    'fun Table.nativeText(name: String, sql: String): Column<String> = registerColumn(name, NativeTextColumnType(sql))',
  ])
}

/** `LongBinary.kt`: the column type of MySQL's bytes without a length, which Exposed has only as streams. */
export function longBinaryFile(context: Context): GeneratedFile | null {
  if (!usesLongBinary(context)) return null
  const pkg = commonPackage(context)
  const imports = new KtImports(pkg).add(`${EXPOSED}.BasicBinaryColumnType`, `${EXPOSED}.Column`, `${EXPOSED}.Table`)
  return ktFile(pathOf(pkg, 'LongBinary'), pkg, imports.write(), [
    '/** Bytes without a length. */',
    'class LongBinaryColumnType : BasicBinaryColumnType() {',
    '    override fun sqlType(): String = "LONGBLOB"',
    '}',
    '',
    '/** A column of bytes without a length. */',
    'fun Table.longBinary(name: String): Column<ByteArray> = registerColumn(name, LongBinaryColumnType())',
  ])
}
