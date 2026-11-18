/**
 * The entity of each table for Doctrine ORM 3: a class with a public property per column and attributes that map
 * it as the database has it (exact table and column names, types with their lengths and precision, keys, unique
 * constraints, indexes, defaults and the values the database fills, which Doctrine reads back after an insert).
 * Doctrine maps no CHECK constraints and, without associations, no foreign keys: the entity names them in its
 * comment, the services check them, and the tests add the foreign keys to the database they create.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbType } from '../../../schema/types.ts'
import type { Line } from '../../types.ts'
import { namespaceOf, optionalType, pathOf, phpFile, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { phpLiteral, phpString } from '../common/php.ts'
import { defaultLiteral } from '../common/repositories.ts'
import { PRECISE, PRECISE_TZ } from './types.ts'

/** The PHP type of a value as Doctrine reads it. */
export function doctrinePhpType(type: DbType): string {
  switch (type.kind) {
    case 'integer':
      return 'int'
    case 'float':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'date':
    case 'time':
    case 'datetime':
      return '\\DateTimeImmutable'
    // DBAL reads binary columns as a stream (a resource) and JSON as what it decodes to
    case 'binary':
    case 'json':
    case 'array':
      return 'mixed'
    // Decimals as text, so no precision is lost
    case 'decimal':
    case 'uuid':
    case 'text':
    case 'enum':
    case 'unknown':
      return 'string'
  }
}

/** The DBAL type of a column, with its length or precision. */
function dbalType(type: DbType): { name: string; length?: number; precision?: number; scale?: number; fixed?: boolean } {
  switch (type.kind) {
    case 'integer':
      return { name: type.bits === 16 ? 'smallint' : type.bits === 64 ? 'bigint' : 'integer' }
    case 'decimal':
      return { name: 'decimal', precision: type.precision ?? 10, scale: type.scale ?? 0 }
    case 'float':
      return { name: type.bits === 32 ? 'smallfloat' : 'float' }
    case 'text':
      return type.length !== undefined ? { name: 'string', length: type.length, fixed: type.fixed } : { name: 'text' }
    case 'boolean':
      return { name: 'boolean' }
    case 'date':
      return { name: 'date_immutable' }
    case 'time':
      return { name: 'time_immutable' }
    // DBAL's own timestamps expect no fractions of a second, which a real database often keeps (types.ts)
    case 'datetime':
      return { name: type.timezone ? PRECISE_TZ : PRECISE }
    case 'uuid':
      return { name: 'guid' }
    case 'binary':
      return type.length !== undefined ? { name: 'binary', length: type.length } : { name: 'blob' }
    case 'json':
    case 'array':
      return { name: 'json' }
    case 'enum':
    case 'unknown':
      return { name: 'string' }
  }
}

const RESERVED = new Set(
  (
    'all and any as asc between by case check column constraint create cross current_date current_time current_timestamp ' +
    'default delete desc distinct drop else end except exists false fetch for foreign from full grant group having in index ' +
    'inner insert intersect into is join key left like limit not null offset on or order outer primary range rank references ' +
    'right row rows select set table then to true union unique update user using values when where window with'
  ).split(' '),
)

/** A name as Doctrine takes it: in backticks when it is a word of SQL, so Doctrine quotes it. */
export const quoted = (name: string) => (RESERVED.has(name.toLowerCase()) || !/^[a-z_][a-z0-9_]*$/.test(name) ? `\`${name}\`` : name)

const quoteSql = (text: string) => `'${text.replace(/'/g, "''")}'`

/** The enum of the database a column holds, when the database keeps it as a type of its own. */
function nativeEnum(context: Context, column: ColumnInfo) {
  const type = column.column.type
  if (type.kind !== 'enum' || context.settings.database === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

/** The columns of a table Doctrine identifies its rows by: the primary key, or, for a table without one, the
 * columns that can be compared as text (Doctrine keys its rows by their identifier). */
export function idColumns(info: TableInfo): ColumnInfo[] {
  if (info.table.primaryKey) return info.key
  const comparable = info.key.filter((column) => column.php !== '\\DateTimeImmutable' && column.php !== 'mixed')
  return comparable.length > 0 ? comparable : info.key
}

function columnLines(context: Context, info: TableInfo, column: ColumnInfo): Line[] {
  const db = column.column
  const type = dbalType(db.type)
  const args: string[] = [`name: ${phpString(quoted(db.name))}`, `type: ${phpString(type.name)}`]
  if (type.length !== undefined) args.push(`length: ${type.length}`)
  if (type.precision !== undefined) args.push(`precision: ${type.precision}`, `scale: ${type.scale ?? 0}`)
  if (db.nullable) args.push('nullable: true')
  const options: string[] = []
  if (type.fixed) options.push("'fixed' => true")
  const todo: string[] = []
  const primary = info.key.includes(column) && info.table.primaryKey !== null
  const identity = db.generated === 'identity' && primary
  let definition: string | null = null
  const notNull = db.nullable ? '' : ' NOT NULL'
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    args.push('insertable: false', 'updatable: false', `generated: ${phpString(db.generated === 'now' ? 'INSERT' : 'ALWAYS')}`)
    options.push("'default' => 'CURRENT_TIMESTAMP'")
  } else if (typeof db.generated === 'object') {
    args.push('insertable: false', 'updatable: false', "generated: 'ALWAYS'")
    definition = `${db.type.sql} GENERATED ALWAYS AS (${db.generated.computed}) STORED`
  } else if (db.generated === 'identity' && !identity) {
    args.push('insertable: false', 'updatable: false', "generated: 'INSERT'")
    todo.push('// TODO: the database numbers this column; Doctrine can only number a single-column key itself')
  } else if (db.default?.kind === 'literal' && db.default.value !== null) options.push(`'default' => ${phpLiteral(db.default.value)}`)
  else if (db.default?.kind === 'expression') {
    args.push('insertable: false', "generated: 'INSERT'")
    definition = `${db.type.sql}${notNull} DEFAULT ${db.default.sql}`
    todo.push(`// TODO: the database fills it on insert with ${db.default.sql}; Doctrine sends no value for it then`)
  }
  const enumType = nativeEnum(context, column)
  if (enumType)
    definition =
      context.settings.database === 'postgresql'
        ? `"${enumType.name}"${notNull}`
        : `ENUM(${enumType.values.map(quoteSql).join(', ')})${notNull}`
  if (db.comment) options.push(`'comment' => ${phpString(db.comment)}`)
  if (definition) args.push(`columnDefinition: ${phpString(definition)}`)
  if (options.length > 0) args.push(`options: [${options.join(', ')}]`)
  if (db.type.kind === 'unknown') todo.push(`// TODO: "${db.type.sql}" has no Doctrine type here; it is mapped as text`)
  if (db.type.kind === 'array') todo.push(`// TODO: "${db.type.sql}" is kept as JSON`)
  const initial =
    db.default?.kind === 'literal' && db.default.value !== null && column.php !== '\\DateTimeImmutable' && column.php !== 'mixed'
      ? defaultLiteral(column, db.default.value)
      : 'null'
  return [
    db.comment && `    /** ${db.comment} */`,
    ...todo.map((line) => `    ${line}`),
    idColumns(info).includes(column) && '    #[ORM\\Id]',
    identity && "    #[ORM\\GeneratedValue(strategy: 'IDENTITY')]",
    `    #[ORM\\Column(${args.join(', ')})]`,
    `    public ${optionalType(column)} $${column.prop} = ${initial};`,
  ]
}

const columnList = (names: string[]) => `[${names.map((name) => phpString(quoted(name))).join(', ')}]`

export function doctrineEntityFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const { table } = info
  const notes: string[] = [
    ...table.foreignKeys.map(
      (key) =>
        ` * Foreign key: ${key.columns.join(', ')} → ${key.references.table}(${key.references.columns.join(', ')})${key.onDelete ? `, on delete ${key.onDelete}` : ''}.`,
    ),
    ...table.checks.map((check) => ` * CHECK (${check.sql}): the service checks what it understands of it.`),
    ...(table.primaryKey
      ? []
      : [
          ` * The table has no primary key: Doctrine tells its rows apart by ${idColumns(info)
            .map((column) => column.column.name)
            .join(', ')}.`,
        ]),
  ]
  const tableArgs = [`name: ${phpString(quoted(table.name))}`, table.schema && `schema: ${phpString(table.schema)}`].filter(Boolean)
  const body: Line[] = [
    '/**',
    ` * A row of the "${table.name}" table${table.comment ? `: ${table.comment}` : ''}.`,
    ...(notes.length > 0 ? [' *', ...notes] : []),
    ' */',
    '#[ORM\\Entity]',
    `#[ORM\\Table(${tableArgs.join(', ')})]`,
    ...table.uniques.map(
      (unique) =>
        `#[ORM\\UniqueConstraint(${unique.name ? `name: ${phpString(unique.name)}, ` : ''}columns: ${columnList(unique.columns)})]`,
    ),
    ...table.indexes.map(
      (index) => `#[ORM\\Index(${index.name ? `name: ${phpString(index.name)}, ` : ''}columns: ${columnList(index.columns)})]`,
    ),
    `class ${info.entity}`,
    '{',
    ...info.columns.flatMap((column, index) => [index > 0 ? '' : null, ...columnLines(context, info, column)]),
    '}',
  ]
  return phpFile(
    pathOf(ns, info.entity),
    ns,
    'use Doctrine\\ORM\\Mapping as ORM;',
    body.filter((line): line is string => typeof line === 'string'),
  )
}

/** The enums of PostgreSQL the tables use, which the tests create before the tables. */
export function pgEnums(context: Context) {
  if (context.settings.database !== 'postgresql') return []
  return context.schema.enums.filter((item) =>
    context.tables.some((info) => info.columns.some((column) => nativeEnum(context, column) === item)),
  )
}
