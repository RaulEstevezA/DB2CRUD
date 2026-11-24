/**
 * The repositories without an ORM: each one writes its SQL and runs it through SQLKit on Db (the pool, or a transaction).
 * Rows are read into the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or
 * after a key; new rows are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a
 * database refusal becomes a conflict. Mirrors csharp/sql/repository.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import { columnOf, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { keyValue, type Method } from '../repositories.ts'
import { swString } from '../swift.ts'
import { bindOptional, bindValue, code, readColumn, selected, statement } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database === 'postgresql' || context.settings.database === 'sqlite'

/** The condition that leaves out rows marked as deleted. */
function softCondition(context: Context, info: TableInfo): string | null {
  if (!info.soft) return null
  const column = q(context, info.soft.column.name)
  return info.soft.column.type.kind === 'boolean' ? `${column} = FALSE` : `${column} IS NULL`
}

function whereSql(conditions: (string | null)[]): string {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? ` WHERE ${present.join(' AND ')}` : ''
}

/** `"id" = …` with the values of some variables. */
const equals = (context: Context, columns: ColumnInfo[]) =>
  columns.map((column) => `${q(context, column.column.name)} = ${bindValue(context, column, column.prop)}`)
/** `"id" = …` with the key of the entity. */
const keyEquals = (context: Context, info: TableInfo) =>
  info.key.map((column) => `${q(context, column.column.name)} = ${bindValue(context, column, `entity.${column.prop}!`)}`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** The statement that reads the rows of a FROM, run on the database. */
const select = (rest: string) => `database.sql.raw(${statement(`SELECT ${code('unsafeRaw: columns')}${rest}`)})`

/** The functions after the type: the columns a read selects, and how a row becomes an entity. */
export function sqlFunctions(context: Context, info: TableInfo): string[] {
  const columns = info.columns.map((column) => selected(context, column)).join(', ')
  return [
    '/// The columns every read selects.',
    `fileprivate let columns = ${swString(columns)}`,
    '',
    `fileprivate func toEntity(_ row: any SQLRow) throws -> ${info.entity} {`,
    `    ${info.entity}(`,
    ...info.columns.map(
      (column, index) => `        ${column.key}: ${readColumn(context, column)}${index === info.columns.length - 1 ? '' : ','}`,
    ),
    '    )',
    '}',
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter. */
const readBack = (context: Context, info: TableInfo) => [
  `return try await ${select(` FROM ${table(context, info)}${whereSql(keyEquals(context, info))}`)}.first().map(toEntity) ?? entity`,
]

/** The line of an insert that gives a column its value, when it has one. */
function givenLine(context: Context, column: ColumnInfo): string {
  const name = swString(q(context, column.column.name))
  const value = statement(bindValue(context, column, 'value'))
  return `if let value = entity.${column.prop} { names.append(${name}); values.append(SQLQueryString(${value})) }`
}

/** The statement of an insert: columns left nil take the database's default. */
function insertLines(context: Context, info: TableInfo): string[] {
  const written = info.columns.filter((column) => writable(column))
  const uuids = written.filter((column) => column.column.generated === 'uuid' && column.sw === 'UUID')
  const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' && !returns(context)
  const into = `INSERT INTO ${table(context, info)}`
  const given = `${into} (${code('unsafeRaw: names.joined(separator: ", ")')}) VALUES (${code('SQLList(values)')})`
  return [
    ...(uuids.length > 0 || identity ? ['var entity = entity'] : []),
    ...uuids.map((column) => `entity.${column.prop} = entity.${column.prop} ?? UUID()`),
    'var names: [String] = []',
    'var values: [any SQLExpression] = []',
    ...written.map((column) => givenLine(context, column)),
    'let insert: SQLQueryString =',
    `    names.isEmpty ? ${statement(`${into}${returns(context) ? ' DEFAULT VALUES' : ' () VALUES ()'}`)}`,
    `    : ${statement(given)}`,
  ]
}

export function sqlBody(context: Context, info: TableInfo, method: Method): string[] {
  const from = ` FROM ${table(context, info)}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(context, info)
  const order = orderBy(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`try await ${select(`${from}${whereSql([...equals(context, columns), soft])}`)}.first().map(toEntity)`]
    case 'listByParent':
    case 'findAllBy':
      return [`try await ${select(`${from}${whereSql([...equals(context, columns), soft])}${order}`)}.all().map(toEntity)`]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset') {
        const page = `${from}${where}${order} LIMIT ${code('bind: limit')} OFFSET ${code('bind: offset')}`
        const count = statement(`SELECT COUNT(*) AS total${from}${where}`)
        return [
          `let total = try await database.sql.raw(${count}).first()?.decode(column: "total", as: Int.self) ?? 0`,
          `let items = try await ${select(page)}.all().map(toEntity)`,
          'return Page(items: items, total: total, offset: offset, limit: limit)',
        ]
      }
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const values = info.key.map((column) => bindValue(context, column, info.key.length === 1 ? 'after' : `after.${column.key}`))
        const after = key.length === 1 ? `${key[0]} > ${values[0]}` : `(${key.join(', ')}) > (${values.join(', ')})`
        const limit = ` LIMIT ${code('bind: limit + 1')}`
        return [
          'let rows =',
          '    if let after {',
          `        try await ${select(`${from}${whereSql([soft, after])}${order}${limit}`)}.all()`,
          '    } else {',
          `        try await ${select(`${from}${where}${order}${limit}`)}.all()`,
          '    }',
          'let items = try rows.prefix(limit).map(toEntity)',
          `return CursorPage(items: items, next: rows.count > limit ? items.last.map { ${keyValue(info, '$0')} } : nil)`,
        ]
      }
      return [`try await ${select(`${from}${where}${order}`)}.all().map(toEntity)`]
    }
    case 'insert': {
      const prepare = insertLines(context, info)
      if (returns(context)) {
        const returning = statement(`${code('insert')} RETURNING ${code('unsafeRaw: columns')}`)
        return [
          ...prepare,
          `let row = try await write { try await database.sql.raw(${returning}).first() }`,
          'return try row.map(toEntity) ?? entity',
        ]
      }
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      return [
        ...prepare,
        ...(identity
          ? ['let id = try await write { try await database.insert(insert) }', `entity.${identity.prop} = entity.${identity.prop} ?? id`]
          : ['try await write { try await database.sql.raw(insert).run() }']),
        ...readBack(context, info),
      ]
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const now = returns(context) ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP(6)'
      const sets = [
        ...changes.map((column) => `${q(context, column.column.name)} = ${bindOptional(context, column, `entity.${column.prop}`)}`),
        ...stamps.map((column) => `${q(context, column.column.name)} = ${now}`),
      ]
      if (sets.length === 0) return readBack(context, info)
      const sql = statement(`UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(keyEquals(context, info))}`)
      return [`try await write { try await database.sql.raw(${sql}).run() }`, ...readBack(context, info)]
    }
    case 'delete': {
      const sql = statement(`DELETE${from}${whereSql(keyEquals(context, info))}`)
      return [`try await write { try await database.sql.raw(${sql}).run() }`]
    }
    default:
      return ['fatalError("not written")']
  }
}
