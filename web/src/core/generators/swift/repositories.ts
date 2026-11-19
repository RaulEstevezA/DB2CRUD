/**
 * The repositories of each table: the protocol services depend on (when the settings want one), its Fluent
 * implementation (queries on the table's model, on the database of the unit of work, models turned into entities, a
 * database refusal turned into a conflict, what the database fills read back after an insert), and its in-memory one,
 * with the same methods. Without protocols, the in-memory repository is a subclass of the database one. Repositories
 * decide nothing.
 */
import type { QueryDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import {
  columnOf,
  fileOf,
  keyType,
  memoryRepository,
  queryName,
  repositoryProtocol,
  sqlRepository,
  stored,
  swFile,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { mappedKey, modelPath, modelValue } from './entities.ts'
import { imports, swString } from './swift.ts'

export interface Method {
  query: QueryDesign
  name: string
  params: string
  returns: string
  doc: string
}

/** The methods of a table's repository, with their Swift signatures. */
export function repositoryMethods(context: Context, info: TableInfo): Method[] {
  const entity = info.entity
  const methods: Method[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns
      .map((column) => columnOf(info, column))
      .map((column) => `_ ${column.prop}: ${column.sw}`)
      .join(', ')
    const add = (params: string, returns: string, doc: string) => methods.push({ query, name, params, returns, doc })
    switch (query.kind) {
      case 'getByKey':
        add(byColumns, `${entity}?`, 'The row with this primary key, or nil.')
        break
      case 'findByUnique':
        add(byColumns, `${entity}?`, `The row with this ${query.columns.join(' and ')}, or nil.`)
        break
      case 'listByParent':
      case 'findAllBy':
        add(byColumns, `[${entity}]`, `Rows with this ${query.columns.join(' and ')}, by primary key.`)
        break
      case 'list':
        if (context.settings.paging === 'offset')
          add('offset: Int, limit: Int', `Page<${entity}>`, 'At most limit rows from offset, by primary key, and how many there are.')
        else if (context.settings.paging === 'cursor')
          add(
            `after: ${keyType(info)}?, limit: Int`,
            `CursorPage<${entity}, ${keyType(info)}>`,
            'At most limit rows after the key after (nil for the first page), by primary key, and the key to read the next page from.',
          )
        else add('', `[${entity}]`, 'Every row, by primary key.')
        break
      case 'insert':
        add(`_ entity: ${entity}`, entity, 'Stores a new row; the values the database fills are read back.')
        break
      case 'update':
        add(`_ entity: ${entity}`, entity, 'Stores the changes made to a row.')
        break
      case 'delete':
        add(`_ entity: ${entity}`, '', 'Removes a row.')
        break
    }
  }
  return methods
}

const writes = (method: Method) => method.query.kind === 'insert' || method.query.kind === 'update'

/** `func findById(_ id: Int) async throws -> Customer?`, with `@discardableResult` when what it returns is the row given. */
const signature = (method: Method, prefix = '') => [
  ...(writes(method) ? ['@discardableResult'] : []),
  `${prefix}func ${method.name}(${method.params}) async throws${method.returns ? ` -> ${method.returns}` : ''}`,
]

// Fluent

/** The enum of PostgreSQL a column holds: its values go in cast to it, as PostgreSQL takes no text for it. */
function pgEnum(context: Context, column: ColumnInfo): string | null {
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

/** The key of an entity known to be stored: `$0.id!`, or a tuple. */
function keyValue(info: TableInfo, variable: string): string {
  if (info.key.length === 1) return `${variable}.${info.key[0].prop}!`
  return `(${info.key.map((column) => `${column.key}: ${variable}.${column.prop}!`).join(', ')})`
}

function fluentBody(context: Context, info: TableInfo, method: Method): string[] {
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
        ...changing.map((column) => {
          const key = swString(column.column.name)
          if (pgEnum(context, column))
            return column.column.nullable
              ? `query.set([${key}: entity.${column.prop}.map { ${bound(context, column, '$0')} } ?? .null])`
              : `if let value = entity.${column.prop} { query.set([${key}: ${bound(context, column, 'value')}]) }`
          return column.column.nullable
            ? `query.set(${modelPath(info, column)}, to: entity.${column.prop})`
            : `if let value = entity.${column.prop} { query.set(${modelPath(info, column)}, to: value) }`
        }),
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
function toEntityFunction(info: TableInfo): string[] {
  return [
    `fileprivate func toEntity(_ model: ${info.model}) -> ${info.entity} {`,
    `    ${info.entity}(${info.columns.map((column) => `${column.key}: ${modelValue(info, column)}`).join(', ')})`,
    '}',
  ]
}

/** write: how a refusal of the database becomes a conflict. */
const writeFunction = (info: TableInfo, prefix: string) => [
  '/// Runs a write; a database refusal (a unique value, a row still pointed to) becomes a conflict.',
  `${prefix}func write<T>(_ work: () async throws -> T) async throws -> T {`,
  '    do {',
  '        return try await work()',
  '    } catch let error as any DatabaseError where error.isConstraintFailure {',
  `        throw DomainError.conflict(entity: ${swString(info.entity)}, reason: "the database refused the change: \\(error)", fields: [])`,
  '    }',
  '}',
]

// In memory

/** A literal of a default, as a Swift value of the column's type, when one can be written. */
function swLiteral(column: ColumnInfo, value: string | number | boolean): string | null {
  const text = String(value)
  switch (column.sw) {
    case 'Int':
    case 'Bool':
      return text
    case 'Double':
    case 'Float':
      return /[.eE]/.test(text) ? text : `${text}.0`
    case 'String':
      return swString(text)
    case 'Decimal':
      return `Decimal(string: ${swString(text)})!`
    case 'UUID':
      return `UUID(uuidString: ${swString(text)})!`
    default:
      return null
  }
}

function memoryFill(column: ColumnInfo): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  if (db.generated === 'identity') return `if ${target} == nil { ${target} = await rows.nextId() }`
  if (db.generated === 'uuid') return `${target} = ${target} ?? UUID()`
  if (db.generated === 'now' || db.generated === 'onUpdateNow') return column.sw === 'Date' ? `${target} = ${target} ?? Date()` : null
  if (db.default?.kind === 'literal' && db.default.value !== null) {
    const literal = swLiteral(column, db.default.value)
    return literal ? `${target} = ${target} ?? ${literal}` : null
  }
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return ''
  return info.soft.column.type.kind === 'boolean' ? `.filter { $0.${info.soft.prop} != true }` : `.filter { $0.${info.soft.prop} == nil }`
}

function memoryBody(context: Context, info: TableInfo, method: Method, fills: string[]): string[] {
  const conditions = method.query.columns
    .map((name) => columnOf(info, name).prop)
    .map((prop) => `$0.${prop} == ${prop}`)
    .join(' && ')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`await visible().first { ${conditions} }`]
    case 'listByParent':
    case 'findAllBy':
      return [`await visible().filter { ${conditions} }`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          'let rows = await visible()',
          'return Page(items: Array(rows.dropFirst(offset).prefix(limit)), total: rows.count, offset: offset, limit: limit)',
        ]
      if (context.settings.paging === 'cursor')
        return [
          'let rows = await visible().filter { row in after.map { isAfter(row, $0) } ?? true }',
          'let items = Array(rows.prefix(limit))',
          `return CursorPage(items: items, next: rows.count > limit ? items.last.map { ${keyValue(info, '$0')} } : nil)`,
        ]
      return ['await visible()']
    case 'insert':
      return [
        ...(fills.length > 0 ? ['var entity = entity', ...fills] : []),
        'let row = entity',
        'await rows.store(row) { sameKey($0, row) }',
        'return row',
      ]
    case 'update':
      return ['await rows.store(entity) { sameKey($0, entity) }', 'return entity']
    case 'delete':
      return ['await rows.remove { sameKey($0, entity) }']
    default:
      return ['fatalError("not written")']
  }
}

/** The order of two values of a column: `<` when they can be compared, by their text otherwise. */
const lessOf = (column: ColumnInfo, a: string, b: string) =>
  column.comparable ? `less(${a}, ${b})` : `less(${a}.map { "\\($0)" }, ${b}.map { "\\($0)" })`

function memoryHelpers(info: TableInfo, cursor: boolean): string[] {
  const entity = info.entity
  const order = info.key.flatMap((column, index) =>
    index < info.key.length - 1
      ? [`    if a.${column.prop} != b.${column.prop} { return ${lessOf(column, `a.${column.prop}`, `b.${column.prop}`)} }`]
      : [`    return ${lessOf(column, `a.${column.prop}`, `b.${column.prop}`)}`],
  )
  const keyPart = (column: ColumnInfo) => (info.key.length === 1 ? 'key' : `key.${column.key}`)
  const after = info.key.flatMap((column, index) => {
    const less = column.comparable
      ? `less(${keyPart(column)}, row.${column.prop})`
      : `less("\\(${keyPart(column)})", row.${column.prop}.map { "\\($0)" })`
    return index < info.key.length - 1 ? [`    if row.${column.prop} != ${keyPart(column)} { return ${less} }`] : [`    return ${less}`]
  })
  return [
    '',
    '/// Whether two rows have the same key.',
    `fileprivate func sameKey(_ a: ${entity}, _ b: ${entity}) -> Bool {`,
    `    ${info.key.map((column) => `a.${column.prop} == b.${column.prop}`).join(' && ')}`,
    '}',
    '',
    '/// Whether a row comes before another, by primary key.',
    `fileprivate func isBefore(_ a: ${entity}, _ b: ${entity}) -> Bool {`,
    ...order,
    '}',
    ...(cursor
      ? [
          '',
          '/// Whether a row comes after a key.',
          `fileprivate func isAfter(_ row: ${entity}, _ key: ${keyType(info)}) -> Bool {`,
          ...after,
          '}',
        ]
      : []),
  ]
}

function block(method: Method, body: string[], prefix: string, doc: boolean): string[] {
  return [
    '',
    ...(doc ? [`    /// ${method.doc}`] : []),
    ...signature(method, prefix).map((line, index, all) => `    ${line}${index === all.length - 1 ? ' {' : ''}`),
    ...body.map((line) => `        ${line}`),
    '    }',
  ]
}

export function repositoryFile(context: Context, info: TableInfo): GeneratedFile {
  const interfaces = context.settings.repositoryInterfaces
  const methods = repositoryMethods(context, info)
  const body: string[] = []
  if (interfaces)
    body.push(
      `/// Where ${info.name} rows are kept. Services depend only on this protocol.`,
      `public protocol ${repositoryProtocol(info)}: Sendable {`,
      ...methods.flatMap((item, index) => [
        ...(index > 0 ? [''] : []),
        `    /// ${item.doc}`,
        ...signature(item).map((line) => `    ${line}`),
      ]),
      '}',
      '',
    )
  const sqlBodies = methods.flatMap((item) => block(item, fluentBody(context, info, item), 'public ', !interfaces))
  const writesRows = methods.some((method) => ['insert', 'update', 'delete'].includes(method.query.kind))
  const reads = methods.some((method) => method.query.kind !== 'delete' && method.query.kind !== 'update')
  body.push(
    `/// Keeps ${info.name} rows in the database, through Fluent: on the database of the unit of work, or on its transaction.`,
    interfaces
      ? `public struct ${sqlRepository(info)}: ${repositoryProtocol(info)} {`
      : `public class ${sqlRepository(info)}: @unchecked Sendable {`,
    interfaces ? '    let database: any Database' : '    private let db: (any Database)?',
    '',
    interfaces ? '    public init(db: any Database) {' : '    public init(db: (any Database)?) {',
    interfaces ? '        self.database = db' : '        self.db = db',
    '    }',
    ...(interfaces
      ? []
      : ['', '    /// The database; the in-memory subclass never asks for it.', '    private var database: any Database { db! }']),
    ...sqlBodies,
    ...(writesRows ? ['', ...writeFunction(info, 'private ').map((line) => `    ${line}`)] : []),
    '}',
    ...(reads || methods.some((method) => method.query.kind === 'insert') ? ['', ...toEntityFunction(info)] : []),
  )
  if (context.settings.memoryRepositories) {
    const fills = info.columns.map(memoryFill).filter((line): line is string => line !== null)
    const cursor = methods.some((method) => method.query.kind === 'list') && context.settings.paging === 'cursor'
    const prefix = interfaces ? 'public ' : 'override public '
    const memoryBodies = methods.flatMap((item) => block(item, memoryBody(context, info, item, fills), prefix, false))
    body.push(
      '',
      `/// Keeps ${info.name} rows in memory, for tests and for trying the services without a database.`,
      interfaces
        ? `public final class ${memoryRepository(info)}: ${repositoryProtocol(info)} {`
        : `public final class ${memoryRepository(info)}: ${sqlRepository(info)}, @unchecked Sendable {`,
      `    private let rows = MemoryRows<${info.entity}>()`,
      '',
      interfaces ? '    public init() {}' : '    public init() {\n        super.init(db: nil)\n    }',
      '',
      '    /// The rows reads see, by primary key.',
      `    private func visible() async -> [${info.entity}] {`,
      `        await rows.all${memoryVisible(info)}.sorted(by: isBefore)`,
      '    }',
      ...memoryBodies,
      '}',
      ...memoryHelpers(info, cursor),
    )
  }
  const usesSql = info.columns.some((column) => pgEnum(context, column))
  return swFile(
    fileOf(context, info, 'repository', `${info.entity}Repository`),
    imports('FluentKit', 'Foundation', ...(usesSql ? ['FluentSQL'] : [])),
    body,
  )
}
