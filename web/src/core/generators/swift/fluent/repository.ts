/**
 * The Fluent repositories: queries on the table's model, on the database of the unit of work, models turned into entities, a
 * database refusal turned into a conflict, what the database fills read back after an insert.
 */
import { typeSql } from '../../../schema/ddl.ts'
import { columnOf, stored, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { keyValue, type Method } from '../repositories.ts'
import { swString } from '../swift.ts'
import { mappedKey, modelPath, modelValue } from './entities.ts'

/** The enum of PostgreSQL a column holds: its values go in cast to it, as PostgreSQL takes no text for it. */
export function pgEnum(context: Context, column: ColumnInfo): string | null {
  const type = column.column.type
  if (type.kind !== 'enum' || context.settings.database !== 'postgresql') return null
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item.name : null
}

const isMysql = (context: Context) => context.settings.database === 'mysql' || context.settings.database === 'mariadb'

/** A column of MariaDB's own uuid type, which Fluent reads and writes as 16 bytes. */
const isMariaUuid = (context: Context, column: ColumnInfo) =>
  column.column.type.kind === 'uuid' &&
  context.settings.database === 'mariadb' &&
  context.schema.dialect === 'mariadb' &&
  /^uuid$/i.test(column.column.type.sql)

/** The type a column is cast to when it is read, when Fluent cannot read its own. */
function readCast(context: Context, column: ColumnInfo): string | null {
  const type = column.column.type
  if (context.settings.database === 'postgresql') {
    if (type.kind === 'json' || type.kind === 'array' || type.kind === 'unknown') return 'text'
    return type.kind === 'time' && type.timezone ? 'time' : null
  }
  if (!isMysql(context)) return null
  if (type.kind === 'json' || column.sw === 'TimeOfDay') return 'CHAR'
  return isMariaUuid(context, column) ? 'BINARY(16)' : null
}

/** The type a value is cast to when it goes to the database, when it would not take it as it is. */
function writeCast(context: Context, column: ColumnInfo): string | null {
  const type = column.column.type
  const name = pgEnum(context, column)
  if (name) return `"${name}"`
  if (context.settings.database === 'postgresql')
    return type.kind === 'json' || type.kind === 'array' || type.kind === 'unknown' || (type.kind === 'time' && type.timezone)
      ? typeSql(context.schema, 'postgresql', type)
      : null
  return isMariaUuid(context, column) ? 'UUID' : null
}

/** Whether the repository of a table writes SQL of its own. */
export const usesSql = (context: Context, info: TableInfo) =>
  info.columns.some(
    (column) =>
      readCast(context, column) !== null ||
      writeCast(context, column) !== null ||
      (context.settings.database !== 'sqlite' && column.column.type.kind === 'date'),
  )

/** A bound value cast to a type. */
const cast = (context: Context, value: string, type: string) =>
  context.settings.database === 'postgresql'
    ? `\\(bind: ${value})::\\(unsafeRaw: ${swString(type)})`
    : `CAST(\\(bind: ${value}) AS ${type})`

/** A value as it goes into a row: bound, or cast to the type of the column. */
function bound(context: Context, column: ColumnInfo, value: string): string {
  const type = writeCast(context, column)
  return type ? `.custom(SQLQueryString("${cast(context, value, type)}"))` : `.bind(${value})`
}

/** The filter that compares a column with a value. */
function compare(context: Context, info: TableInfo, column: ColumnInfo, value: string, operator = '=='): string {
  // A date would be compared with the date and time Fluent sends
  const type =
    context.settings.database !== 'sqlite' && column.column.type.kind === 'date'
      ? 'DATE'
      : pgEnum(context, column)
        ? null
        : writeCast(context, column)
  if (!type) return `.filter(${modelPath(info, column)} ${operator} ${value})`
  const sql = `\\(ident: ${swString(column.column.name)}) ${operator === '==' ? '=' : operator} ${cast(context, value, type)}`
  return `.filter(.custom(SQLQueryString("${sql}")))`
}

/** The filter that leaves out rows marked as deleted. */
function softFilter(info: TableInfo): string {
  if (!info.soft) return ''
  const path = modelPath(info, info.soft)
  if (info.soft.column.type.kind !== 'boolean') return `.filter(${path} == nil)`
  return `.group(.or) { $0.filter(${path} == false).filter(${path} == nil) }`
}

/** The columns written by an insert: not those the database fills (uuids are made first). */
const insertColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined || column.column.generated === 'uuid')

/** The columns written by an update: not the key, nor those the database fills. */
const updateColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined && !info.key.includes(column))

/** The filters of a row, by its key as a source has it: `entity.id!` or `model.id!`. */
const keyFilter = (context: Context, info: TableInfo, value: (column: ColumnInfo) => string) =>
  mappedKey(info)
    .map((column) => compare(context, info, column, value(column)))
    .join('')

/** The order of the key, by column name: a key path cannot go through a composite key. */
const sortByKey = (info: TableInfo) => info.key.map((column) => `.sort(${swString(column.column.name)})`).join('')

/** The lines of an update that set the columns: first those cast to their type, as setting several at once replaces what was set. */
function setLines(context: Context, columns: ColumnInfo[]): string[] {
  const casts = columns.filter((column) => writeCast(context, column))
  return casts.length === 0
    ? []
    : [
        'var values: [FieldKey: DatabaseQuery.Value] = [:]',
        ...casts.map((column) => {
          const key = swString(column.column.name)
          return column.column.nullable
            ? `values[${key}] = entity.${column.prop}.map { ${bound(context, column, '$0')} } ?? .null`
            : `if let value = entity.${column.prop} { values[${key}] = ${bound(context, column, 'value')} }`
        }),
        'query.set(values)',
      ]
}

/** The line of an update that sets a column. */
function setLine(info: TableInfo, column: ColumnInfo): string {
  return column.column.nullable
    ? `query.set(${modelPath(info, column)}, to: entity.${column.prop})`
    : `if let value = entity.${column.prop} { query.set(${modelPath(info, column)}, to: value) }`
}

export function fluentBody(context: Context, info: TableInfo, method: Method): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softFilter(info)
  const query = `${info.model}.query(on: database)`
  // What is read of a row, with the columns Fluent cannot read cast by the database
  const read = info.columns.some((column) => readCast(context, column)) ? `${query}.selecting(${info.model}.selected)` : query
  const byColumns = columns.map((column) => compare(context, info, column, column.prop)).join('')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`try await ${read}${byColumns}${soft}.first().map(toEntity)`]
    case 'listByParent':
    case 'findAllBy':
      return [`try await ${read}${byColumns}${soft}${sortByKey(info)}.all().map(toEntity)`]
    case 'list': {
      if (context.settings.paging === 'offset')
        return [
          `let total = try await ${query}${soft}.count()`,
          `let rows = try await ${read}${soft}${sortByKey(info)}.offset(offset).limit(limit).all()`,
          'return Page(items: rows.map(toEntity), total: total, offset: offset, limit: limit)',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const value = (column: ColumnInfo) => (info.key.length === 1 ? 'after' : `after.${column.key}`)
        const terms = info.key.map((column, index) => {
          const before = info.key.slice(0, index).map((other) => compare(context, info, other, value(other)))
          const greater = compare(context, info, column, value(column), '>')
          return index === 0 ? `or${greater}` : `or.group(.and) { and in and${before.join('')}${greater} }`
        })
        return [
          `let query = ${read}${soft}`,
          'if let after {',
          ...(info.key.length === 1
            ? [`    query${compare(context, info, info.key[0], 'after', '>')}`]
            : ['    query.group(.or) { or in', ...terms.map((term) => `        ${term}`), '    }']),
          '}',
          `let rows = try await query${sortByKey(info)}.limit(limit + 1).all()`,
          'let items = rows.prefix(limit).map(toEntity)',
          `return CursorPage(items: items, next: rows.count > limit ? items.last.map { ${keyValue(info, '$0')} } : nil)`,
        ]
      }
      return [`try await ${read}${soft}${sortByKey(info)}.all().map(toEntity)`]
    }
    case 'insert': {
      const key = mappedKey(info)
      const identity = key.length === 1 && key[0].column.generated === 'identity' ? key[0] : null
      const uuids = insertColumns(info).filter((column) => column.column.generated === 'uuid')
      const values = insertColumns(info).map((column) =>
        column.column.generated === 'uuid'
          ? `values[${swString(column.column.name)}] = .bind(${column.prop})`
          : `if let value = entity.${column.prop} { values[${swString(column.column.name)}] = ${bound(context, column, 'value')} }`,
      )
      // The row is read back by the key it now has: the one the database numbered, the one made here, or the one given
      const keyOf = (column: ColumnInfo) =>
        column === identity ? 'numbered!' : uuids.includes(column) ? column.prop : `entity.${column.prop}!`
      return [
        // Only the values given: the database fills the others (Fluent's create sends DEFAULT, which SQLite takes as NULL)
        ...uuids.map((column) => `let ${column.prop} = entity.${column.prop} ?? UUID()`),
        `${values.length > 0 ? 'var' : 'let'} values: [FieldKey: DatabaseQuery.Value] = [:]`,
        ...values,
        `let insert = ${query}.set(values)`,
        'insert.query.action = .create',
        ...(identity
          ? [
              `nonisolated(unsafe) var numbered: ${identity.sw}?`,
              `try await write { try await insert.run { numbered = try? $0.decode(${swString(identity.column.name)}, as: ${identity.sw}.self) } }`,
            ]
          : ['try await write { try await insert.run() }']),
        `let stored = try await ${read}${keyFilter(context, info, keyOf)}.first()`,
        'return stored.map(toEntity) ?? entity',
      ]
    }
    case 'update': {
      const changing = updateColumns(info)
      if (changing.length === 0) return ['// Nothing of it can change', 'return entity']
      return [
        `let query = ${query}${keyFilter(context, info, (column) => stored(`entity.${column.prop}`, column))}`,
        ...setLines(context, changing),
        ...changing.filter((column) => !writeCast(context, column)).map((column) => setLine(info, column)),
        'try await write { try await query.update() }',
        'return entity',
      ]
    }
    case 'delete':
      return [
        `try await write { try await ${query}${keyFilter(context, info, (column) => stored(`entity.${column.prop}`, column))}.delete() }`,
      ]
    default:
      return ['fatalError("not written")']
  }
}

/** The columns a read selects, when the database casts some of them. */
function selectedColumns(context: Context, info: TableInfo): string[] {
  if (!info.columns.some((column) => readCast(context, column))) return []
  const { schema, name } = info.table
  const table = [...(schema ? [schema] : []), name]
  return [
    `extension ${info.model} {`,
    '    /// The columns of a row, those Fluent cannot read cast by the database.',
    '    fileprivate static var selected: [DatabaseQuery.Field] {',
    '        [',
    ...info.columns.map((column) => {
      const key = swString(column.column.name)
      const type = readCast(context, column)
      if (!type) return `            .extendedPath([${key}], schema: schema, space: space),`
      const path = [...table, column.column.name].map((part) => `\\(ident: ${swString(part)})`).join('.')
      return `            .custom(SQLQueryString("CAST(${path} AS ${type}) AS \\(ident: ${swString([...table, column.column.name].join('_'))})")),`
    }),
    '        ]',
    '    }',
    '}',
    '',
    'extension QueryBuilder {',
    '    fileprivate func selecting(_ fields: [DatabaseQuery.Field]) -> Self {',
    '        query.fields = fields',
    '        return self',
    '    }',
    '}',
    '',
  ]
}

/** toEntity: how a model becomes an entity. */
export function toEntityFunction(context: Context, info: TableInfo): string[] {
  return [
    ...selectedColumns(context, info),
    `fileprivate func toEntity(_ model: ${info.model}) -> ${info.entity} {`,
    `    ${info.entity}(${info.columns.map((column) => `${column.key}: ${modelValue(info, column)}`).join(', ')})`,
    '}',
  ]
}
