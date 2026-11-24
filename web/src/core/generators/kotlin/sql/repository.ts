/**
 * The repositories without an ORM: each one writes its SQL and runs it through Sql over a JDBC Connection. Rows are read into
 * the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or after a key; new rows
 * are read back (with RETURNING on PostgreSQL, by their key elsewhere); and a database refusal becomes a ConflictException.
 * Mirrors java/sql/repository.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import { columnOf, errorsPackage, qualified, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { ktString, type KtImports } from '../kotlin.ts'
import type { Method } from '../repositories.ts'
import { readColumn } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database === 'postgresql'

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

const equals = (context: Context, columns: ColumnInfo[]) => columns.map((column) => `${q(context, column.column.name)} = ?`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** The arguments after the SQL: the values of the statement. */
const args = (values: string[]) => values.map((value) => `, ${value}`).join('')
const keyValues = (info: TableInfo) => info.key.map((column) => `entity.${column.prop}`)

/** The columns every read selects, and the connection of a class that may have none. */
export function sqlHead(context: Context, info: TableInfo): string[] {
  const held = context.settings.repositoryInterfaces
    ? []
    : ['    private val connection get() = checkNotNull(held) { "This repository has no connection" }', '']
  // A constant of the file would clash between repositories of the same package
  const columns = info.columns.map((column) => q(context, column.column.name)).join(', ')
  return [...held, '    /** The columns every read selects. */', `    private val columns = ${ktString(columns)}`]
}

/** How a row read with the columns becomes an entity, and how writes report a refusal. */
export function sqlHelpers(context: Context, info: TableInfo, imports: KtImports): string[] {
  imports.add('java.sql.ResultSet')
  const writes = info.queries.some((item) => item.kind === 'insert' || item.kind === 'update' || item.kind === 'delete')
  if (writes) imports.add(`${context.base}.RefusedException`, qualified(errorsPackage(context), 'ConflictException'))
  return [
    '',
    `    private fun toEntity(row: ResultSet): ${info.entity} = fill(row, ${info.entity}())`,
    '',
    '    /** Reads a row selected with the columns into entity. */',
    `    private fun fill(row: ResultSet, entity: ${info.entity}): ${info.entity} {`,
    ...info.columns.map((column, index) => `        entity.${column.prop} = ${readColumn(context, column, index + 1, imports)}`),
    '        return entity',
    '    }',
    ...(writes
      ? [
          '',
          '    /** Runs a write; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */',
          '    private fun <T> write(work: () -> T): T =',
          '        try {',
          '            work()',
          '        } catch (error: RefusedException) {',
          `            throw ConflictException(${ktString(info.entity)}, "the database refused the change: \${error.message}")`,
          '        }',
        ]
      : []),
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter, into the entity. */
function readBack(context: Context, info: TableInfo): string[] {
  const sql = ktString(` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`)
  return [
    `return Sql.one(connection, "SELECT " + columns + ${sql}${args(keyValues(info))}) { fill(it, entity) }`,
    `    ?: error("The ${info.entity} just written is not there")`,
  ]
}

/** `id` turned into the type of the key. */
function fromId(kt: string): string {
  if (kt === 'Int') return 'id?.toInt()'
  return kt === 'Short' ? 'id?.toShort()' : 'id'
}

/** The values of an insert, and its SQL: values left null take the database's default. */
function insertLines(context: Context, info: TableInfo, imports: KtImports): string[] {
  const written = info.columns.filter((column) => writable(column))
  const uuids = written.filter((column) => column.column.generated === 'uuid')
  if (uuids.length > 0) imports.add('java.util.UUID')
  const into = `INSERT INTO ${table(context, info)}`
  const mysql = context.settings.database === 'mysql' || context.settings.database === 'mariadb'
  return [
    ...uuids.map((column) => `entity.${column.prop} = entity.${column.prop} ?: UUID.randomUUID()`),
    'val given = listOf<Pair<String, Any?>>(',
    ...written.map((column) => `    ${ktString(q(context, column.column.name))} to entity.${column.prop},`),
    ').filter { it.second != null }',
    'val values = given.map { it.second }.toTypedArray()',
    'val sql =',
    `    if (given.isEmpty()) ${ktString(`${into}${mysql ? ' () VALUES ()' : ' DEFAULT VALUES'}`)}`,
    `    else ${ktString(`${into} (`)} + given.joinToString(", ") { it.first } + ") VALUES (" + given.joinToString(", ") { "?" } + ")"`,
  ]
}

export function sqlBody(context: Context, info: TableInfo, method: Method, imports: KtImports): string[] {
  imports.add(`${context.base}.Sql`)
  const entity = info.entity
  const from = ` FROM ${table(context, info)}`
  const select = (rest: string) => `"SELECT " + columns + ${ktString(`${from}${rest}`)}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const byValues = args(columns.map((column) => column.prop))
  const soft = softCondition(context, info)
  const order = orderBy(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return Sql.one(connection, ${select(whereSql([...equals(context, columns), soft]))}${byValues}) { toEntity(it) }`]
    case 'listByParent':
    case 'findAllBy':
      return [
        `return Sql.all(connection, ${select(`${whereSql([...equals(context, columns), soft])}${order}`)}${byValues}) { toEntity(it) }`,
      ]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset')
        return [
          `val items = Sql.all(connection, ${select(`${where}${order} LIMIT ? OFFSET ?`)}, limit, offset) { toEntity(it) }`,
          `val total = Sql.one(connection, ${ktString(`SELECT COUNT(*)${from}${where}`)}) { it.getLong(1) } ?: 0L`,
          'return Page(items, total, offset, limit)',
        ]
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const after = key.length === 1 ? `${key[0]} > ?` : `(${key.join(', ')}) > (${key.map(() => '?').join(', ')})`
        const next = info.key.map((column) => `items.last().${column.prop}!!`)
        return [
          'val rows =',
          `    if (after == null) Sql.all(connection, ${select(`${where}${order} LIMIT ?`)}, limit + 1) { toEntity(it) }`,
          `    else Sql.all(connection, ${select(`${whereSql([soft, after])}${order} LIMIT ?`)}, *after.toTypedArray(), limit + 1) { toEntity(it) }`,
          'val items = rows.take(limit)',
          `return CursorPage(items, if (rows.size > limit) listOf<Any>(${next.join(', ')}) else null)`,
        ]
      }
      return [`return Sql.all(connection, ${select(`${where}${order}`)}) { toEntity(it) }`]
    }
    case 'insert': {
      const prepare = insertLines(context, info, imports)
      if (returns(context))
        return [
          ...prepare,
          'return write { Sql.one(connection, sql + " RETURNING " + columns, *values) { fill(it, entity) } }',
          `    ?: error("The ${entity} just written is not there")`,
        ]
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      return [
        ...prepare,
        `${identity ? 'val id = ' : ''}write { Sql.insert(connection, sql, *values) }`,
        ...(identity ? [`entity.${identity.prop} = entity.${identity.prop} ?: ${fromId(identity.kt)}`] : []),
        ...readBack(context, info),
      ]
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const mysql = context.settings.database === 'mysql' || context.settings.database === 'mariadb'
      const now = mysql ? 'CURRENT_TIMESTAMP(6)' : 'CURRENT_TIMESTAMP'
      const sets = [...equals(context, changes), ...stamps.map((column) => `${q(context, column.column.name)} = ${now}`)]
      if (sets.length === 0) return readBack(context, info)
      const sql = ktString(`UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key))}`)
      const values = [...changes.map((column) => `entity.${column.prop}`), ...keyValues(info)]
      return [`write { Sql.run(connection, ${sql}${args(values)}) }`, ...readBack(context, info)]
    }
    case 'delete': {
      const sql = ktString(`DELETE${from}${whereSql(equals(context, info.key))}`)
      return [`write { Sql.run(connection, ${sql}${args(keyValues(info))}) }`]
    }
    default:
      return ['throw UnsupportedOperationException()']
  }
}
