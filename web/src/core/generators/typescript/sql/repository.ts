/**
 * The repositories without an ORM: each one writes its SQL and runs it on a Db (the database or a transaction,
 * sql/database.ts). Rows become the project's plain entities through the readers each driver needs; reads leave
 * out rows marked as deleted; pages go by offset or after a key; new rows are read back (with RETURNING, or by
 * their key on MySQL and MariaDB); and a database refusal becomes a ConflictError. Mirrors python/sql/index.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import type { Line } from '../../types.ts'
import { quote, type TsImports } from '../typescript.ts'
import type { ColumnInfo, Context, TableInfo } from '../common/context.ts'
import type { RepositoryMethod } from '../common/orm.ts'
import { dialectOf, mark, readValue, writesJson } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => dialectOf(context) !== 'mysql'

/** `"id", "name"`: the columns every read selects. */
const selectList = (context: Context, info: TableInfo) => info.columns.map((column) => q(context, column.column.name)).join(', ')

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

/** `"a" = $1 AND …`, numbering the marks from `start`. */
const equals = (context: Context, columns: ColumnInfo[], start = 0) =>
  columns.map((column, index) => `${q(context, column.column.name)} = ${mark(context, start + index)}`)

const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** A value of the entity as the driver writes it. */
function param(context: Context, column: ColumnInfo, value: string, imports: TsImports): string {
  if (!writesJson(context, column.column.type)) return value
  imports.from('src/database', 'toJson')
  return `toJson(${value})`
}

const params = (values: string[]) => `[${values.join(', ')}]`

/** The key of the entity as the parameters of a query. */
const keyParams = (context: Context, info: TableInfo, imports: TsImports, target = 'entity') =>
  params(info.key.map((column) => param(context, column, `${target}.${column.prop}`, imports)))

/** The constant of the columns a read selects, and the entity of a row. */
export function sqlHelpers(context: Context, info: TableInfo, imports: TsImports): Line[] {
  imports.type('src/database', 'Row')
  const values = info.columns.map((column) => {
    const { expression, reader } = readValue(context, column.column.type, `row[${quote(column.column.name)}]`)
    if (reader) imports.from('src/database', reader)
    return `    ${column.prop}: ${expression} as ${column.ts}${column.column.nullable ? ' | null' : ''},`
  })
  return [
    '/** The columns every read selects. */',
    `const COLUMNS = ${quote(selectList(context, info))}`,
    '',
    `/** The ${info.entity} of a row read with COLUMNS. */`,
    `function toEntity(row: Row): ${info.entity} {`,
    `  return Object.assign(new ${info.entity}(), {`,
    ...values,
    '  })',
    '}',
  ]
}

/** A write, with a refusal of the database turned into a ConflictError. */
function write(info: TableInfo, action: Line[], imports: TsImports, after: Line[] = []): Line[] {
  imports.from('src/database', 'isRefusal').from('src/errors', 'ConflictError')
  return [
    'try {',
    ...action.map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    '} catch (error) {',
    `  if (isRefusal(error)) throw new ConflictError('${info.entity}', \`the database refused the change: \${(error as Error).message}\`)`,
    '  throw error',
    '}',
    ...after,
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter, into the entity. */
function readBack(context: Context, info: TableInfo, imports: TsImports): Line[] {
  return [
    `const row = await this.db.one('SELECT ' + COLUMNS + ${quote(` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`)}, ${keyParams(context, info, imports)})`,
    `if (row === null) throw new Error('The ${info.entity} just written is not there')`,
    'return Object.assign(entity, toEntity(row))',
  ]
}

export function sqlBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const from = ` FROM ${table(context, info)}`
  const select = (rest: string) => `'SELECT ' + COLUMNS + ${quote(`${from}${rest}`)}`
  const byColumns = method.query.columns.map((name) => info.columns.find((column) => column.column.name === name)!)
  const byParams = params(byColumns.map((column) => param(context, column, column.prop, imports)))
  const soft = softCondition(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `const row = await this.db.one(${select(whereSql([...equals(context, byColumns), soft]))}, ${byParams})`,
        'return row === null ? null : toEntity(row)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        `const rows = await this.db.all(${select(`${whereSql([...equals(context, byColumns), soft])}${orderBy(context, info)}`)}, ${byParams})`,
        'return rows.map(toEntity)',
      ]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset')
        return [
          `const rows = await this.db.all(${select(`${where}${orderBy(context, info)} LIMIT ${mark(context, 0)} OFFSET ${mark(context, 1)}`)}, [limit, offset])`,
          `const counted = await this.db.one(${quote(`SELECT COUNT(*) AS total${from}${where}`)})`,
          'return { items: rows.map(toEntity), total: Number(counted?.total ?? 0), offset, limit }',
        ]
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const marks = info.key.map((_, index) => mark(context, index))
        const after = key.length === 1 ? `${key[0]} > ${marks[0]}` : `(${key.join(', ')}) > (${marks.join(', ')})`
        return [
          'const rows =',
          '  after === null',
          `    ? await this.db.all(${select(`${where}${orderBy(context, info)} LIMIT ${mark(context, 0)}`)}, [limit + 1])`,
          `    : await this.db.all(${select(`${whereSql([soft, after])}${orderBy(context, info)} LIMIT ${mark(context, info.key.length)}`)}, [...after, limit + 1])`,
          'const items = rows.slice(0, limit).map(toEntity)',
          'const last = items[items.length - 1]',
          `return { items, next: rows.length > limit ? [${info.key.map((column) => `last.${column.prop}`).join(', ')}] : null }`,
        ]
      }
      return [`const rows = await this.db.all(${select(`${where}${orderBy(context, info)}`)})`, 'return rows.map(toEntity)']
    }
    case 'insert': {
      const columns = info.columns.filter(writable)
      const uuids = columns.filter((column) => column.column.generated === 'uuid')
      if (uuids.length > 0) imports.from('node:crypto', 'randomUUID')
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      const into = `INSERT INTO ${table(context, info)}`
      const numbered = dialectOf(context) === 'postgresql'
      // Values left undefined take the database's default
      const prepare: Line[] = [
        ...uuids.map((column) => `if (entity.${column.prop} === undefined) entity.${column.prop} = randomUUID()`),
        'const given = (',
        '  [',
        ...columns.map(
          (column) => `    [${quote(q(context, column.column.name))}, ${param(context, column, `entity.${column.prop}`, imports)}],`,
        ),
        '  ] as [string, unknown][]',
        ').filter(([, value]) => value !== undefined)',
        "const names = given.map(([name]) => name).join(', ')",
        numbered ? "const marks = given.map((_, index) => `$${index + 1}`).join(', ')" : "const marks = given.map(() => '?').join(', ')",
        'const values = given.map(([, value]) => value)',
      ]
      if (returns(context))
        return write(
          info,
          [
            ...prepare,
            'const sql =',
            '  given.length > 0',
            `    ? ${quote(`${into} (`)} + names + ') VALUES (' + marks + ') RETURNING ' + COLUMNS`,
            `    : ${quote(`${into} DEFAULT VALUES RETURNING `)} + COLUMNS`,
            'const row = await this.db.one(sql, values)',
            `if (row === null) throw new Error('The ${info.entity} just written is not there')`,
            'return Object.assign(entity, toEntity(row))',
          ],
          imports,
        )
      return write(
        info,
        [
          ...prepare,
          `const id = await this.db.run(${quote(`${into} (`)} + names + ') VALUES (' + marks + ')', values)`,
          identity && `if (entity.${identity.prop} === undefined) entity.${identity.prop} = id as ${identity.ts}`,
        ],
        imports,
        readBack(context, info, imports),
      )
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const sets = [
        ...changes.map((column, index) => `${q(context, column.column.name)} = ${mark(context, index)}`),
        ...stamps.map((column) => `${q(context, column.column.name)} = CURRENT_TIMESTAMP`),
      ]
      if (sets.length === 0) return readBack(context, info, imports)
      const values = params([
        ...changes.map((column) => param(context, column, `entity.${column.prop}`, imports)),
        ...info.key.map((column) => param(context, column, `entity.${column.prop}`, imports)),
      ])
      const sql = `UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key, changes.length))}`
      return write(info, [`await this.db.run(${quote(sql)}, ${values})`], imports, readBack(context, info, imports))
    }
    case 'delete':
      return write(
        info,
        [`await this.db.run(${quote(`DELETE${from}${whereSql(equals(context, info.key))}`)}, ${keyParams(context, info, imports)})`],
        imports,
      )
    default:
      return ["throw new Error('not written')"]
  }
}
