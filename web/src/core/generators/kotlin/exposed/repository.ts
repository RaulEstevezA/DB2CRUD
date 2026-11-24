/**
 * The Exposed repositories: DSL queries on the table object, each in a transaction that joins the one already open, rows
 * turned into entities, writes stored at once so a database refusal becomes a ConflictException, what the database fills
 * read back after an insert.
 */
import { columnOf, errorsPackage, qualified, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { ktString, type KtImports } from '../kotlin.ts'
import type { Method } from '../repositories.ts'

const CORE = 'org.jetbrains.exposed.v1.core'
const JDBC = 'org.jetbrains.exposed.v1.jdbc'

const t = (info: TableInfo, column: ColumnInfo) => `${info.tableObject}.${column.prop}`

/** The condition that leaves out rows marked as deleted. */
function softCondition(info: TableInfo, imports: KtImports): string | null {
  if (!info.soft) return null
  imports.add(`${CORE}.isNull`)
  const column = t(info, info.soft)
  if (info.soft.column.type.kind !== 'boolean') return `${column}.isNull()`
  imports.add(`${CORE}.eq`, `${CORE}.or`)
  return `((${column} eq false) or ${column}.isNull())`
}

/** Conditions joined with `and`, each between parentheses when there are several. */
function all(conditions: string[], imports: KtImports): string {
  if (conditions.length > 1) imports.add(`${CORE}.and`)
  return conditions.length === 1 ? conditions[0] : conditions.map((condition) => `(${condition})`).join(' and ')
}

/** The columns written by an insert: not those the database fills (uuids are made first). */
const insertColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined || column.column.generated === 'uuid')

/** The columns written by an update: not the key, nor those the database fills. */
const updateColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined && !info.key.includes(column))

/** The row of an entity, by its key. */
function keyCondition(info: TableInfo, imports: KtImports): string {
  imports.add(`${CORE}.eq`)
  return all(
    info.key.map((column) => `${t(info, column)} eq entity.${column.prop}${column.column.nullable ? '' : '!!'}`),
    imports,
  )
}

function orderBy(info: TableInfo, imports: KtImports): string {
  imports.add(`${CORE}.SortOrder`)
  return `.orderBy(${info.key.map((column) => `${t(info, column)} to SortOrder.ASC`).join(', ')})`
}

/** The query of a list, read with or without conditions. */
const select = (info: TableInfo, condition: string | null) => `${info.tableObject}.selectAll()${condition ? `.where { ${condition} }` : ''}`

export function exposedBody(context: Context, info: TableInfo, method: Method, imports: KtImports): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info, imports)
  const byColumns = () => {
    imports.add(`${CORE}.eq`)
    return columns.map((column) => `${t(info, column)} eq ${column.prop}`)
  }
  const read = (lines: string[]) => ['return exposedTransaction(db) {', ...lines.map((line) => `    ${line}`), '}']
  imports.add(`${JDBC}.selectAll`)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return read([`${select(info, all([...byColumns(), ...(soft ? [soft] : [])], imports))}.map { toEntity(it) }.singleOrNull()`])
    case 'listByParent':
    case 'findAllBy':
      return read([
        `${select(info, all([...byColumns(), ...(soft ? [soft] : [])], imports))}${orderBy(info, imports)}.map { toEntity(it) }`,
      ])
    case 'list': {
      if (context.settings.paging === 'offset')
        return read([
          `val query = ${select(info, soft)}`,
          'val total = query.count()',
          `val items = query${orderBy(info, imports)}.limit(limit).offset(offset.toLong()).map { toEntity(it) }`,
          'Page(items, total, offset, limit)',
        ])
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        imports.add(`${CORE}.greater`)
        if (info.key.length > 1) imports.add(`${CORE}.eq`, `${CORE}.or`)
        for (const column of info.key) if (column.ktImport) imports.add(column.ktImport)
        const value = (column: ColumnInfo, index: number) => `(after[${index}] as ${column.kt})`
        const after = info.key
          .map((column, index) =>
            all(
              [
                ...info.key.slice(0, index).map((before, position) => `${t(info, before)} eq ${value(before, position)}`),
                `${t(info, column)} greater ${value(column, index)}`,
              ],
              imports,
            ),
          )
          .map((item) => (info.key.length > 1 ? `(${item})` : item))
          .join(' or ')
        const withAfter = soft ? all([soft, after], imports) : after
        return read([
          `val query = if (after == null) ${select(info, soft)} else ${select(info, withAfter)}`,
          `val rows = query${orderBy(info, imports)}.limit(limit + 1).map { toEntity(it) }`,
          'val items = rows.take(limit)',
          `CursorPage(items, if (rows.size > limit) listOf<Any>(${info.key.map((column) => `items.last().${column.prop}!!`).join(', ')}) else null)`,
        ])
      }
      return read([`${select(info, soft)}${orderBy(info, imports)}.map { toEntity(it) }`])
    }
    case 'insert': {
      imports.add(`${JDBC}.insert`)
      const uuids = info.columns
        .filter((column) => column.column.generated === 'uuid')
        .map((column) => {
          imports.add('java.util.UUID')
          return `    entity.${column.prop} = entity.${column.prop} ?: UUID.randomUUID()`
        })
      const identity = info.table.primaryKey?.length === 1 ? info.key.find((column) => column.column.generated === 'identity') : undefined
      return [
        'return write {',
        ...uuids,
        `    ${identity ? 'val statement = ' : ''}${info.tableObject}.insert { row ->`,
        ...insertColumns(info).map((column) => `        entity.${column.prop}?.let { row[${t(info, column)}] = it }`),
        '    }',
        ...(identity ? [`    entity.${identity.prop} = statement[${t(info, identity)}]`] : []),
        // What the database filled is read back, by the key the row now has
        ...(info.table.primaryKey ? [`    fill(entity, ${select(info, keyCondition(info, imports))}.single())`] : []),
        '    entity',
        '}',
      ]
    }
    case 'update':
      imports.add(`${JDBC}.update`)
      return [
        'return write {',
        `    ${info.tableObject}.update({ ${keyCondition(info, imports)} }) { row ->`,
        ...updateColumns(info).map((column) =>
          column.column.nullable
            ? `        row[${t(info, column)}] = entity.${column.prop}`
            : `        entity.${column.prop}?.let { row[${t(info, column)}] = it }`,
        ),
        '    }',
        '    entity',
        '}',
      ]
    case 'delete':
      imports.add(`${JDBC}.deleteWhere`)
      return ['write {', `    ${info.tableObject}.deleteWhere { ${keyCondition(info, imports)} }`, '}']
    default:
      return ['throw UnsupportedOperationException()']
  }
}

/** toEntity, fill and write: how rows become entities, and how a refusal of the database becomes a ConflictException. */
export function exposedHelpers(context: Context, info: TableInfo, imports: KtImports): string[] {
  imports.add(`${CORE}.ResultRow`)
  const writes = info.queries.some((item) => item.kind === 'insert' || item.kind === 'update' || item.kind === 'delete')
  if (writes) imports.add('org.jetbrains.exposed.v1.exceptions.ExposedSQLException', qualified(errorsPackage(context), 'ConflictException'))
  return [
    '',
    `    private fun toEntity(row: ResultRow): ${info.entity} = ${info.entity}().also { fill(it, row) }`,
    '',
    `    private fun fill(entity: ${info.entity}, row: ResultRow) {`,
    ...info.columns.map((column) => `        entity.${column.prop} = row[${t(info, column)}]`),
    '    }',
    ...(writes
      ? [
          '',
          '    /** Runs a write in a transaction; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */',
          '    private fun <T> write(work: () -> T): T =',
          '        try {',
          '            exposedTransaction(db) { work() }',
          '        } catch (error: ExposedSQLException) {',
          '            // SQLSTATE class 23: the change breaks a constraint (SQLite says so in its message)',
          '            if (!error.sqlState.startsWith("23") && error.cause?.message?.contains("SQLITE_CONSTRAINT") != true) throw error',
          `            throw ConflictException(${ktString(info.entity)}, "the database refused the change: \${error.cause?.message}")`,
          '        }',
        ]
      : []),
  ]
}
