/**
 * The repositories of each table: the protocol services depend on (when the settings want one), its database
 * implementation (its bodies are the strategy's, orm.ts), and its in-memory one, with the same methods. Without protocols,
 * the in-memory repository is a subclass of the database one. Repositories decide nothing.
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
  swFile,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { identifiedLists, listOf } from './documents.ts'
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
      case 'addItem':
      case 'removeItem': {
        const list = listOf(info, query)
        const adds = query.kind === 'addItem'
        // Told apart by its position, it is only removed from a list of the size it was seen in
        const size = !adds && list.by === 'position' ? [{ name: 'size', type: 'Int' }] : []
        const params = [
          ...info.key.map((column) => ({ name: column.prop, type: column.sw })),
          ...(adds ? [{ name: list.item, type: list.sw }] : list.params),
          ...size,
        ]
        add(
          params.map((item) => `_ ${item.name}: ${item.type}`).join(', '),
          `${entity}?`,
          adds
            ? `Adds an item to ${query.columns[0]}, and gives the row as it is then, if there is one.`
            : `Removes an item from ${query.columns[0]}${size.length > 0 ? ' that has this size' : ''}, and gives the row as it is then, if there is one.`,
        )
        break
      }
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

/** The key of an entity known to be stored: `$0.id!`, or a tuple. */
export function keyValue(info: TableInfo, variable: string): string {
  if (info.key.length === 1) return `${variable}.${info.key[0].prop}!`
  return `(${info.key.map((column) => `${column.key}: ${variable}.${column.prop}!`).join(', ')})`
}

/** write: how a refusal of the database becomes a conflict. */
const writeFunction = (context: Context, info: TableInfo, prefix: string) => [
  '/// Runs a write; a database refusal (a unique value, a row still pointed to) becomes a conflict.',
  `${prefix}func write<T>(_ work: () async throws -> T) async throws -> T {`,
  '    do {',
  '        return try await work()',
  `    } catch ${context.orm.repository.refusal} {`,
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

export function memoryFill(column: ColumnInfo): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  if (db.generated === 'identity') return `if ${target} == nil { ${target} = await rows.nextId() }`
  if (db.generated === 'uuid' && db.type.kind === 'text' && db.type.objectId) return `${target} = ${target} ?? Bson.newId()`
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
        ...(fills.length > 0 || identifiedLists(info).length > 0 ? ['var entity = entity', ...fills] : []),
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems()'] : []),
        'let row = entity',
        'await rows.store(row) { sameKey($0, row) }',
        'return row',
      ]
    case 'update':
      if (identifiedLists(info).length > 0)
        return [
          'var entity = entity',
          'entity.identifyItems()',
          'let row = entity',
          'await rows.store(row) { sameKey($0, row) }',
          'return row',
        ]
      return ['await rows.store(entity) { sameKey($0, entity) }', 'return entity']
    case 'addItem':
    case 'removeItem':
      return memoryItem(info, method)
    case 'delete':
      return ['await rows.remove { sameKey($0, entity) }']
    default:
      return ['fatalError("not written")']
  }
}

/** One item of a list added or removed in memory. */
function memoryItem(info: TableInfo, method: Method): string[] {
  const list = listOf(info, method.query)
  const [param] = list.params
  const items = `found.${list.column.prop}`
  const adds = method.query.kind === 'addItem'
  const keys = info.key.map((column) => `$0.${column.prop} == ${column.prop}`).join(' && ')
  const touched = info.columns.filter(({ column }) => column.generated === 'onUpdateNow')
  const change = adds
    ? [
        ...(list.by === 'id' ? [`var ${list.item} = ${list.item}`, `${list.item}.id = ${list.item}.id ?? Bson.newId()`] : []),
        `${items} = (${items} ?? []) + [${list.item}]`,
      ]
    : list.by === 'position'
      ? [`guard ${items}?.count == size, position >= 0, position < size else { return nil }`, `${items}?.remove(at: position)`]
      : [`${items}?.removeAll { $0${list.by === 'id' ? '.id' : ''} == ${param.name} }`]
  return [
    `guard var found = await visible().first(where: { ${keys} }) else { return nil }`,
    ...change,
    ...(info.version ? [`found.${info.version.prop} = (found.${info.version.prop} ?? 0) + 1`] : []),
    ...touched.map((column) => `found.${column.prop} = Date()`),
    'let row = found',
    'await rows.store(row) { sameKey($0, row) }',
    'return row',
  ]
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
  const { holder } = context.orm
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
  const sqlBodies = methods.flatMap((item) => block(item, context.orm.repository.body(context, info, item), 'public ', !interfaces))
  const writesRows = methods.some((method) => ['insert', 'update', 'delete', 'addItem', 'removeItem'].includes(method.query.kind))
  const functions = context.orm.repository.functions(context, info)
  const reads = methods.some((method) => method.query.kind !== 'delete' && method.query.kind !== 'update')
  body.push(
    `/// Keeps ${info.name} rows in the database, through ${context.orm.label}: on the database of the unit of work, or on its transaction.`,
    interfaces
      ? `public struct ${sqlRepository(info)}: ${repositoryProtocol(info)} {`
      : `public class ${sqlRepository(info)}: @unchecked Sendable {`,
    interfaces ? `    let database: ${holder.type}` : `    private let db: ${holder.optional}`,
    '',
    interfaces ? `    public init(db: ${holder.type}) {` : `    public init(db: ${holder.optional}) {`,
    interfaces ? '        self.database = db' : '        self.db = db',
    '    }',
    ...(interfaces
      ? []
      : ['', '    /// The database; the in-memory subclass never asks for it.', `    private var database: ${holder.type} { db! }`]),
    ...sqlBodies,
    ...(writesRows ? ['', ...writeFunction(context, info, 'private ').map((line) => `    ${line}`)] : []),
    '}',
    ...(functions.length > 0 && (reads || methods.some((method) => method.query.kind === 'insert')) ? ['', ...functions] : []),
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
  return swFile(
    fileOf(context, info, 'repository', `${info.entity}Repository`),
    imports('Foundation', ...context.orm.repository.modules(context, info)),
    body,
  )
}
