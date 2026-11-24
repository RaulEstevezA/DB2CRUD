/**
 * The repositories without an ORM: each one writes its SQL and runs it through Db, over one connection and its
 * transaction. Rows are read into the plain entities column by column; reads leave out rows marked as deleted; pages go by
 * offset or after a key; new rows are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and
 * MariaDB); and a database refusal becomes a ConflictException. Mirrors java/sql/repository.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import type { Line } from '../../types.ts'
import { csString, type CsUsings } from '../csharp.ts'
import { columnOf, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import type { Method } from '../repositories.ts'
import { readColumn, writeValue } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database === 'postgresql' || context.settings.database === 'sqlite'

/** The types of PostgreSQL that Npgsql gives as a text only when the database turns them into one. */
const AS_TEXT = new Set(['enum', 'array', 'unknown'])

/** `"id", "name"`: the columns every read selects, in the order Fill reads them. */
const selectList = (context: Context, info: TableInfo) =>
  info.columns
    .map((column) => {
      const name = q(context, column.column.name)
      return context.settings.database === 'postgresql' && AS_TEXT.has(column.column.type.kind) ? `${name}::text` : name
    })
    .join(', ')

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

/** `"id" = @p1`, with the markers numbered after the first ones. */
const equals = (context: Context, columns: ColumnInfo[], first = 0) =>
  columns.map((column, index) => `${q(context, column.column.name)} = @p${first + index + 1}`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** The arguments after the others: the values of the statement. */
const args = (values: string[]) => values.map((value) => `, ${value}`).join('')

/** The property of entity, as the statement takes it. */
const given = (context: Context, column: ColumnInfo, usings: CsUsings) =>
  writeValue(context, column, `entity.${column.prop}`, column.optional, usings)
const keyValues = (context: Context, info: TableInfo, usings: CsUsings) => info.key.map((column) => given(context, column, usings))

/** The columns a read selects. */
export function sqlHead(context: Context, info: TableInfo): Line[] {
  return [
    '    /// <summary>The columns every read selects.</summary>',
    `    private const string Columns = ${csString(selectList(context, info))};`,
  ]
}

/** How a row read with Columns becomes an entity. */
export function sqlTail(context: Context, info: TableInfo, usings: CsUsings): Line[] {
  usings.add('System.Data.Common')
  return [
    '',
    `    /// <summary>The ${info.entity} of a row read with Columns.</summary>`,
    `    private static ${info.entity} ToEntity(DbDataReader row) => Fill(row, new ${info.entity}());`,
    '',
    '    /// <summary>Reads a row selected with Columns into entity.</summary>',
    `    private static ${info.entity} Fill(DbDataReader row, ${info.entity} entity)`,
    '    {',
    ...info.columns.map((column, index) => `        entity.${column.prop} = ${readColumn(context, column, index, usings)};`),
    '        return entity;',
    '    }',
  ]
}

/** A write, with a refusal of the database turned into a ConflictException. */
function write(info: TableInfo, action: Line[], after: Line[] = []): Line[] {
  return [
    'try',
    '{',
    ...action.map((line) => (typeof line === 'string' ? `    ${line}` : line)),
    '}',
    'catch (RefusedException error)',
    '{',
    `    throw new ConflictException(${csString(info.entity)}, $"the database refused the change: {error.Message}");`,
    '}',
    ...after,
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter, into the entity. */
function readBack(context: Context, info: TableInfo, usings: CsUsings): Line[] {
  const sql = csString(` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`)
  return [
    `return await db.OneAsync("SELECT " + Columns + ${sql}, row => Fill(row, entity)${args(keyValues(context, info, usings))})`,
    `    ?? throw new InvalidOperationException("The ${info.entity} just written is not there");`,
  ]
}

/** When a new row gives the column its value: the others take the database's default. */
function isGiven(info: TableInfo, column: ColumnInfo): string | null {
  const target = `entity.${column.prop}`
  if (column.optional) return `${target} is not null`
  const filled = column.column.generated !== undefined || column.column.default !== undefined
  if (!info.key.includes(column) || !filled) return null
  return column.valueType ? `${target} != default` : `${target} is not null`
}

/** The names and the values of an insert, and its SQL. */
function insertLines(context: Context, info: TableInfo, usings: CsUsings): Line[] {
  const written = info.columns.filter(writable)
  const into = `INSERT INTO ${table(context, info)}`
  const empty = returns(context) ? ' DEFAULT VALUES' : ' () VALUES ()'
  const add = (column: ColumnInfo) =>
    `names.Add(${csString(q(context, column.column.name))}); values.Add(${given(context, column, usings)});`
  return [
    ...written
      .filter((column) => column.column.generated === 'uuid' && column.cs === 'Guid')
      .map((column) =>
        column.optional
          ? `entity.${column.prop} ??= Guid.NewGuid();`
          : `if (entity.${column.prop} == Guid.Empty) entity.${column.prop} = Guid.NewGuid();`,
      ),
    'var names = new List<string>();',
    'var values = new List<object?>();',
    ...written.map((column) => {
      const condition = isGiven(info, column)
      return condition ? `if (${condition}) { ${add(column)} }` : add(column)
    }),
    written.every((column) => isGiven(info, column) !== null)
      ? [
          'var sql = names.Count == 0',
          `    ? ${csString(`${into}${empty}`)}`,
          `    : ${csString(`${into} (`)} + string.Join(", ", names) + ") VALUES (" + Db.Markers(names.Count) + ")";`,
        ]
      : [`var sql = ${csString(`${into} (`)} + string.Join(", ", names) + ") VALUES (" + Db.Markers(names.Count) + ")";`],
  ].flat()
}

export function sqlBody(context: Context, info: TableInfo, method: Method, usings: CsUsings): Line[] {
  const entity = info.entity
  const from = ` FROM ${table(context, info)}`
  const select = (rest: string) => `"SELECT " + Columns + ${csString(`${from}${rest}`)}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const byValues = args(columns.map((column) => writeValue(context, column, column.local, false, usings)))
  const soft = softCondition(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return await db.OneAsync(${select(whereSql([...equals(context, columns), soft]))}, ToEntity${byValues});`]
    case 'listByParent':
    case 'findAllBy':
      return [
        `return await db.AllAsync(${select(`${whereSql([...equals(context, columns), soft])}${orderBy(context, info)}`)}, ToEntity${byValues});`,
      ]
    case 'list': {
      const where = whereSql([soft])
      const order = orderBy(context, info)
      if (context.settings.paging === 'offset')
        return [
          `var items = await db.AllAsync(${select(`${where}${order} LIMIT @p1 OFFSET @p2`)}, ToEntity, limit, offset);`,
          `var total = await db.OneAsync(${csString(`SELECT COUNT(*)${from}${where}`)}, row => row.GetInt64(0));`,
          `return new Page<${entity}>(items, total, offset, limit);`,
        ]
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const markers = key.map((_, index) => `@p${index + 1}`)
        const after = key.length === 1 ? `${key[0]} > ${markers[0]}` : `(${key.join(', ')}) > (${markers.join(', ')})`
        const afterValues = info.key.map((column, index) => {
          const plain = `after[${index}]`
          const cast = `((${column.cs})${plain})`
          const value = writeValue(context, column, cast, false, usings)
          return value === cast ? plain : value
        })
        return [
          'var rows = after is null',
          `    ? await db.AllAsync(${select(`${where}${order} LIMIT @p1`)}, ToEntity, limit + 1)`,
          `    : await db.AllAsync(${select(`${whereSql([soft, after])}${order} LIMIT @p${key.length + 1}`)}, ToEntity${args(afterValues)}, limit + 1);`,
          'var items = rows.Take(limit).ToList();',
          `return new CursorPage<${entity}>(items, rows.Count > limit ? [${info.key.map((column) => `items[^1].${column.prop}`).join(', ')}] : null);`,
        ]
      }
      return [`return await db.AllAsync(${select(`${where}${order}`)}, ToEntity);`]
    }
    case 'insert': {
      const prepare = insertLines(context, info, usings)
      if (returns(context))
        return [
          ...prepare,
          ...write(info, [
            'return await db.OneAsync(sql + " RETURNING " + Columns, row => Fill(row, entity), values.ToArray())',
            `    ?? throw new InvalidOperationException("The ${entity} just written is not there");`,
          ]),
        ]
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      return [
        ...prepare,
        ...write(
          info,
          identity
            ? [
                'var id = await db.InsertAsync(sql, values.ToArray());',
                `if (entity.${identity.prop} == 0) entity.${identity.prop} = ${identity.cs === 'long' ? 'id' : `(${identity.cs})id`};`,
              ]
            : ['await db.RunAsync(sql, values.ToArray());'],
          readBack(context, info, usings),
        ),
      ]
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const now =
        context.settings.database === 'mysql' || context.settings.database === 'mariadb' ? 'CURRENT_TIMESTAMP(6)' : 'CURRENT_TIMESTAMP'
      const sets = [...equals(context, changes), ...stamps.map((column) => `${q(context, column.column.name)} = ${now}`)]
      if (sets.length === 0) return readBack(context, info, usings)
      const sql = `UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key, changes.length))}`
      const values = [...changes.map((column) => given(context, column, usings)), ...keyValues(context, info, usings)]
      return write(info, [`await db.RunAsync(${csString(sql)}${args(values)});`], readBack(context, info, usings))
    }
    case 'delete':
      return write(info, [
        `await db.RunAsync(${csString(`DELETE${from}${whereSql(equals(context, info.key))}`)}${args(keyValues(context, info, usings))});`,
      ])
    default:
      return ['throw new NotSupportedException();']
  }
}
