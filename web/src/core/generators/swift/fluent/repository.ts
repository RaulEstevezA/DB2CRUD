/**
 * The Fluent repositories: queries on the table's model, on the database of the unit of work, models turned into entities, a
 * database refusal turned into a conflict, what the database fills read back after an insert.
 */
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

/** A value as it goes into a row: bound, or cast to the enum of PostgreSQL the column holds. */
function bound(context: Context, column: ColumnInfo, value: string): string {
  const name = pgEnum(context, column)
  return name ? `.custom(SQLQueryString("\\(bind: ${value})::\\(unsafeRaw: ${swString(`"${name}"`)})"))` : `.bind(${value})`
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
const keyFilter = (info: TableInfo, value: (column: ColumnInfo) => string) =>
  mappedKey(info)
    .map((column) => `.filter(${modelPath(info, column)} == ${value(column)})`)
    .join('')

/** The order of the key, by column name: a key path cannot go through a composite key. */
const sortByKey = (info: TableInfo) => info.key.map((column) => `.sort(${swString(column.column.name)})`).join('')

/** The line of an update that sets a column. */
function setLine(context: Context, info: TableInfo, column: ColumnInfo): string {
  const key = swString(column.column.name)
  if (pgEnum(context, column))
    return column.column.nullable
      ? `query.set([${key}: entity.${column.prop}.map { ${bound(context, column, '$0')} } ?? .null])`
      : `if let value = entity.${column.prop} { query.set([${key}: ${bound(context, column, 'value')}]) }`
  return column.column.nullable
    ? `query.set(${modelPath(info, column)}, to: entity.${column.prop})`
    : `if let value = entity.${column.prop} { query.set(${modelPath(info, column)}, to: value) }`
}

export function fluentBody(context: Context, info: TableInfo, method: Method): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softFilter(info)
  const query = `${info.model}.query(on: database)`
  const byColumns = columns.map((column) => `.filter(${modelPath(info, column)} == ${column.prop})`).join('')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`try await ${query}${byColumns}${soft}.first().map(toEntity)`]
    case 'listByParent':
    case 'findAllBy':
      return [`try await ${query}${byColumns}${soft}${sortByKey(info)}.all().map(toEntity)`]
    case 'list': {
      if (context.settings.paging === 'offset')
        return [
          `let total = try await ${query}${soft}.count()`,
          `let rows = try await ${query}${soft}${sortByKey(info)}.offset(offset).limit(limit).all()`,
          'return Page(items: rows.map(toEntity), total: total, offset: offset, limit: limit)',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const value = (column: ColumnInfo) => (info.key.length === 1 ? 'after' : `after.${column.key}`)
        const terms = info.key.map((column, index) => {
          const before = info.key.slice(0, index).map((other) => `.filter(${modelPath(info, other)} == ${value(other)})`)
          const greater = `.filter(${modelPath(info, column)} > ${value(column)})`
          return index === 0 ? `or${greater}` : `or.group(.and) { and in and${before.join('')}${greater} }`
        })
        return [
          `let query = ${query}${soft}`,
          'if let after {',
          ...(info.key.length === 1
            ? [`    query.filter(${modelPath(info, info.key[0])} > after)`]
            : ['    query.group(.or) { or in', ...terms.map((term) => `        ${term}`), '    }']),
          '}',
          `let rows = try await query${sortByKey(info)}.limit(limit + 1).all()`,
          'let items = rows.prefix(limit).map(toEntity)',
          `return CursorPage(items: items, next: rows.count > limit ? items.last.map { ${keyValue(info, '$0')} } : nil)`,
        ]
      }
      return [`try await ${query}${soft}${sortByKey(info)}.all().map(toEntity)`]
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
        `let stored = try await ${query}${keyFilter(info, keyOf)}.first()`,
        'return stored.map(toEntity) ?? entity',
      ]
    }
    case 'update': {
      const changing = updateColumns(info)
      if (changing.length === 0) return ['// Nothing of it can change', 'return entity']
      return [
        `let query = ${query}${keyFilter(info, (column) => stored(`entity.${column.prop}`, column))}`,
        ...changing.map((column) => setLine(context, info, column)),
        'try await write { try await query.update() }',
        'return entity',
      ]
    }
    case 'delete':
      return [`try await write { try await ${query}${keyFilter(info, (column) => stored(`entity.${column.prop}`, column))}.delete() }`]
    default:
      return ['fatalError("not written")']
  }
}

/** toEntity: how a model becomes an entity. */
export function toEntityFunction(info: TableInfo): string[] {
  return [
    `fileprivate func toEntity(_ model: ${info.model}) -> ${info.entity} {`,
    `    ${info.entity}(${info.columns.map((column) => `${column.key}: ${modelValue(info, column)}`).join(', ')})`,
    '}',
  ]
}
