/**
 * Storage of each resource in the Vapor project: the repository protocol the service depends on, the typed filters
 * of its lists, and the implementation of the chosen persistence:
 * - `memory`: an actor with a dictionary, to run the API without a database
 * - `none`: every method answers 501, with a TODO where the storage goes
 * - `fluent`: a Fluent model and migration, and a repository with filters and sorting written for each field
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines, type Lines } from '../../common/text.ts'
import { swDoc, swHeader, swString, swType } from '../../languages/swift/swift.ts'
import { column, keyField, keyType, names, property, sourcePath, type VaporContext } from './context.ts'
import { fieldType, storedAsJson } from './model.ts'

/** Whether a field can be filtered and sorted: plain values, enums and single references. */
export function queryable(field: SpecField): boolean {
  return !storedAsJson(field) && (field.type.kind === 'scalar' || field.type.kind === 'enum')
}

/** The fields the lists of a resource filter by. */
export function filterFields(resource: SpecResource): SpecField[] {
  const wires = new Set(resource.endpoints.flatMap((endpoint) => (endpoint.operation === 'list' ? endpoint.filters : [])))
  return resource.fields.filter((field) => wires.has(field.wire) && queryable(field))
}

/** The fields the lists of a resource sort by. */
export function sortFields(resource: SpecResource): SpecField[] {
  const wires = new Set(resource.endpoints.flatMap((endpoint) => (endpoint.operation === 'list' ? endpoint.sort : [])))
  return resource.fields.filter((field) => wires.has(field.wire) && queryable(field))
}

/** A value of a field as the memory repository compares it: booleans and UUIDs have no order of their own. */
function comparable(context: VaporContext, resource: SpecResource, field: SpecField, value: string): string {
  const type = fieldType(context, field, resource)
  const key = field.name === resource.key.field
  if (type === 'Bool') return `${value}.map { $0 ? 1 : 0 }`
  if (type === 'UUID') return key ? `${value}.uuidString` : `${value}?.uuidString`
  return value
}

/** How two keys are ordered. */
function keyOrder(resource: SpecResource, a: string, b: string): string {
  const key = property(keyField(resource))
  return keyType(resource) === 'UUID' ? `${a}.${key}.uuidString < ${b}.${key}.uuidString` : `${a}.${key} < ${b}.${key}`
}

/** The column of a field in its Fluent model: its Swift type and database type, and how values go in and out. */
interface Column {
  type: string
  dataType: string
  write(value: string): string
  read(value: string): string
  /** The value a filter compares with the column */
  match(value: string): string
}

function plain(type: string, dataType: string): Column {
  return { type, dataType, write: (value) => value, read: (value) => value, match: (value) => value }
}

function keyColumn(target: SpecResource): { type: string; dataType: string } {
  const type = keyType(target)
  return { type, dataType: type === 'Int64' ? '.int64' : type === 'UUID' ? '.uuid' : '.string' }
}

function columnOf(context: VaporContext, resource: SpecResource, field: SpecField): Column {
  if (field.name === resource.key.field) {
    const key = keyColumn(resource)
    return plain(key.type, key.dataType)
  }
  if (storedAsJson(field)) {
    const type = fieldType(context, field, resource)
    return {
      type: 'String',
      dataType: '.custom("TEXT")',
      write: (value) => `jsonText(${value})`,
      read: (value) => `jsonValue(${value}, as: ${type}.self)`,
      match: (value) => value,
    }
  }
  if (field.reference) {
    const key = keyColumn(context.spec.resources.find((item) => item.name === field.reference)!)
    return plain(key.type, key.dataType)
  }
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const enumType = swType(type.name)
    const integer = item.valueType === 'integer'
    return {
      type: integer ? 'Int64' : 'String',
      dataType: integer ? '.int64' : '.string',
      write: (value) => `${value}?.rawValue`,
      read: (value) => `${value}.flatMap(${enumType}.init(rawValue:))`,
      match: (value) => `${value}.rawValue`,
    }
  }
  if (type.kind !== 'scalar') return plain('String', '.custom("TEXT")')
  switch (type.scalar) {
    case 'integer':
      return type.bits === 64 ? plain('Int64', '.int64') : plain('Int32', '.int32')
    case 'float':
      return plain('Double', '.double')
    case 'decimal':
      // Kept as a double in the database: every driver reads it the same way
      return {
        type: 'Double',
        dataType: '.double',
        write: (value) => `${value}.map { NSDecimalNumber(decimal: $0).doubleValue }`,
        read: (value) => `${value}.flatMap { Decimal(string: String($0)) }`,
        match: (value) => `NSDecimalNumber(decimal: ${value}).doubleValue`,
      }
    case 'boolean':
      return plain('Bool', '.bool')
    case 'datetime':
      return plain('Date', '.datetime')
    case 'uuid':
      return plain('UUID', '.uuid')
    default: {
      const length = field.constraints.maxLength
      return plain('String', length !== undefined && length <= 255 ? '.string' : '.custom("TEXT")')
    }
  }
}

/** The Fluent model of a resource and its migration. */
export function recordFile(context: VaporContext, resource: SpecResource): GeneratedFile | null {
  if (!context.fluent) return null
  const name = names(resource)
  const generated = resource.key.generated === 'increment' ? '.database' : '.user'
  const key = keyField(resource)
  const others = resource.fields.filter((field) => field.name !== resource.key.field)
  const properties = others.map((field) => {
    const columnOfField = columnOf(context, resource, field)
    return `    @OptionalField(key: ${swString(column(field))}) var ${recordProperty(field)}: ${columnOfField.type}?`
  })
  const keyColumnOf = columnOf(context, resource, key)
  const fields = others.map((field) => `            .field(${swString(column(field))}, ${columnOf(context, resource, field).dataType})`)
  const content = lines(
    ...swHeader(`The ${name.table} table.`, ['Fluent', 'Foundation']),
    swDoc(`A row of the ${name.table} table.`),
    `final class ${name.record}: Model, @unchecked Sendable {`,
    `    static let schema = ${swString(name.table)}`,
    '',
    `    @ID(custom: ${swString(column(key))}, generatedBy: ${generated}) var id: ${keyColumnOf.type}?`,
    properties,
    '',
    '    init() {}',
    '}',
    '',
    swDoc(`Creates the ${name.table} table; the application runs it when it starts.`),
    `struct ${name.migration}: AsyncMigration {`,
    '    func prepare(on database: any Database) async throws {',
    `        try await database.schema(${name.record}.schema)`,
    `            .field(${swString(column(key))}, ${keyColumnOf.dataType}, .identifier(auto: ${resource.key.generated === 'increment'}))`,
    fields,
    '            .ignoreExisting()',
    '            .create()',
    '    }',
    '',
    '    func revert(on database: any Database) async throws {',
    `        try await database.schema(${name.record}.schema).delete()`,
    '    }',
    '}',
  )
  return { path: sourcePath(context.layout.resource(resource, 'database'), name.record), content: fileText(content) }
}

/** The property of a field in a Fluent model: `id` is the key's. */
function recordProperty(field: SpecField): string {
  const name = property(field)
  return name === 'id' ? 'idValue' : name
}

export function repositoryFile(context: VaporContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const key = keyType(resource)
  const keyName = property(keyField(resource))
  const generated = resource.key.generated
  const filters = filterFields(resource)
  const imports = new Set(['Foundation'])
  const filterStruct = [
    swDoc(`What a list of ${resource.plural} can filter by: a field that has a value must be equal to it.`),
    filters.length > 0
      ? [
          `struct ${name.filters}: Sendable {`,
          filters.map((field) => `    var ${property(field)}: ${fieldType(context, field, resource)}?`),
          '}',
        ]
      : `struct ${name.filters}: Sendable {}`,
  ]
  const protocol = [
    swDoc(`Where ${resource.plural} are kept. The service depends only on this protocol.`),
    `protocol ${name.repository}: Sendable {`,
    '    /// Items equal to every filter, in order, within the window; and how many match.',
    `    func list(_ query: ListQuery<${name.filters}>) async throws -> ListResult<${name.type}>`,
    '',
    '    /// The item with this key, or nil when there is none.',
    `    func get(_ key: ${key}) async throws -> ${name.type}?`,
    '',
    `    /// Stores a new item${generated ? ' and assigns its key' : ''}; returns it as stored.`,
    `    func add(_ item: ${name.type}) async throws -> ${name.type}`,
    '',
    '    /// Stores the new state of an existing item and returns it.',
    `    func update(_ item: ${name.type}) async throws -> ${name.type}`,
    '',
    '    /// Removes an existing item.',
    `    func delete(_ key: ${key}) async throws`,
    '}',
  ]
  const newKey = key === 'UUID' ? 'UUID()' : 'UUID().uuidString.lowercased()'
  let implementation: Lines[]
  if (context.pending) {
    const message = swString(`The storage of ${resource.plural} is not written yet`)
    const method = (signature: string) => [
      `    func ${signature} {`,
      `        // TODO: store ${resource.plural} in your database`,
      `        throw ApiError.notImplemented(${message})`,
      '    }',
    ]
    implementation = [
      swDoc(`Storage of ${resource.plural} to write: every method answers 501 until it is implemented.`),
      `struct ${name.pendingRepository}: ${name.repository} {`,
      method(`list(_ query: ListQuery<${name.filters}>) async throws -> ListResult<${name.type}>`),
      '',
      method(`get(_ key: ${key}) async throws -> ${name.type}?`),
      '',
      method(`add(_ item: ${name.type}) async throws -> ${name.type}`),
      '',
      method(`update(_ item: ${name.type}) async throws -> ${name.type}`),
      '',
      method(`delete(_ key: ${key}) async throws`),
      '}',
    ]
  } else if (!context.fluent) {
    const sorts = sortFields(resource)
    const conditions = filters.map((field) => `(filters.${property(field)}.map { item.${property(field)} == $0 } ?? true)`)
    const assign =
      generated === 'increment'
        ? ['        lastKey += 1', `        item.${keyName} = lastKey`]
        : generated === 'uuid'
          ? [`        item.${keyName} = ${newKey}`]
          : null
    implementation = [
      swDoc(`Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API.`),
      `actor ${name.memory}: ${name.repository} {`,
      `    private var items: [${key}: ${name.type}] = [:]`,
      generated === 'increment' && '    private var lastKey: Int64 = 0',
      '',
      `    func list(_ query: ListQuery<${name.filters}>) async throws -> ListResult<${name.type}> {`,
      conditions.length > 0 && '        let filters = query.filters',
      `        ${sorts.length > 0 ? 'var' : 'let'} found = items.values.sorted { ${keyOrder(resource, '$0', '$1')} }${conditions.length > 0 ? `.filter { item in\n            ${conditions.join('\n                && ')}\n        }` : ''}`,
      sorts.length > 0 && [
        '        // Items without a value go last, whatever the order; equal ones keep the order of their keys',
        '        switch query.sortField {',
        sorts.map((field) => [
          `        case ${swString(field.wire)}:`,
          `            found.sort { a, b in comesFirst(${comparable(context, resource, field, `a.${property(field)}`)}, ${comparable(context, resource, field, `b.${property(field)}`)}, descending: query.descending) ?? (${keyOrder(resource, 'a', 'b')}) }`,
        ]),
        '        default:',
        '            break',
        '        }',
      ],
      '        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)',
      '        return ListResult(items: Array(window), total: found.count)',
      '    }',
      '',
      `    func get(_ key: ${key}) async throws -> ${name.type}? {`,
      '        items[key]',
      '    }',
      '',
      `    func add(_ item: ${name.type}) async throws -> ${name.type} {`,
      assign ? ['        var item = item', assign] : null,
      `        items[item.${keyName}] = item`,
      '        return item',
      '    }',
      '',
      `    func update(_ item: ${name.type}) async throws -> ${name.type} {`,
      `        items[item.${keyName}] = item`,
      '        return item',
      '    }',
      '',
      `    func delete(_ key: ${key}) async throws {`,
      '        items[key] = nil',
      '    }',
      '}',
    ]
  } else {
    imports.add('Fluent')
    const sorts = sortFields(resource)
    const others = resource.fields.filter((field) => field.name !== resource.key.field)
    const columns = others.map((field) => ({ field, ...columnOf(context, resource, field) }))
    const keyPath = (field: SpecField) => (field.name === resource.key.field ? '\\.$id' : `\\.$${recordProperty(field).replace(/`/g, '')}`)
    const filterLines = filters.map((field) => {
      const match = field.name === resource.key.field ? 'value' : columnOf(context, resource, field).match('value')
      return [
        `        if let value = query.filters.${property(field)} {`,
        `            select.filter(${keyPath(field)} == ${match})`,
        '        }',
      ]
    })
    // In the order of the fields: the order of the memberwise initializer
    const toItem = resource.fields.map((field) =>
      field.name === resource.key.field
        ? `${keyName}: try record.requireID()`
        : `${property(field)}: ${columnOf(context, resource, field).read(`record.${recordProperty(field)}`)}`,
    )
    implementation = [
      swDoc(`Keeps ${resource.plural} in the database with Fluent.`),
      `struct ${name.fluentRepository}: ${name.repository} {`,
      '    let database: any Database',
      '',
      `    func list(_ query: ListQuery<${name.filters}>) async throws -> ListResult<${name.type}> {`,
      `        let select = ${name.record}.query(on: database)`,
      filterLines,
      '        let total = try await select.copy().count()',
      sorts.length > 0 && [
        '        let direction: DatabaseQuery.Sort.Direction = query.descending ? .descending : .ascending',
        '        // Items without a value go last, whatever the order; the key breaks ties',
        '        switch query.sortField {',
        sorts.map((field) => [
          `        case ${swString(field.wire)}:`,
          field.name === resource.key.field
            ? '            select.sort(\\.$id, direction)'
            : `            select.sort(nullsLast(${swString(column(field))})).sort(${keyPath(field)}, direction)`,
        ]),
        '        default:',
        '            break',
        '        }',
      ],
      '        select.sort(\\.$id).offset(query.offset)',
      '        if let limit = query.limit {',
      '            select.limit(limit)',
      '        }',
      '        return ListResult(items: try await select.all().map(toItem), total: total)',
      '    }',
      '',
      `    func get(_ key: ${key}) async throws -> ${name.type}? {`,
      `        try await ${name.record}.find(key, on: database).map(toItem)`,
      '    }',
      '',
      `    func add(_ item: ${name.type}) async throws -> ${name.type} {`,
      `        let record = ${name.record}()`,
      generated === 'uuid' ? `        record.id = ${newKey}` : generated === null ? `        record.id = item.${keyName}` : null,
      '        write(item, to: record)',
      '        try await record.create(on: database)',
      '        return try toItem(record)',
      '    }',
      '',
      `    func update(_ item: ${name.type}) async throws -> ${name.type} {`,
      `        guard let record = try await ${name.record}.find(item.${keyName}, on: database) else {`,
      `            throw ApiError.notFound(${swString(resource.singular)})`,
      '        }',
      '        write(item, to: record)',
      '        try await record.update(on: database)',
      '        return try toItem(record)',
      '    }',
      '',
      `    func delete(_ key: ${key}) async throws {`,
      `        try await ${name.record}.query(on: database).filter(\\.$id == key).delete()`,
      '    }',
      '',
      '    /// Every field of an item in its column; the key is set apart.',
      `    private func write(_ item: ${name.type}, to record: ${name.record}) {`,
      columns.length > 0
        ? columns.map(({ field, write }) => `        record.${recordProperty(field)} = ${write(`item.${property(field)}`)}`)
        : '        _ = record',
      '    }',
      '',
      `    private func toItem(_ record: ${name.record}) throws -> ${name.type} {`,
      `        ${name.type}(`,
      toItem.map((item, index) => `            ${item}${index < toItem.length - 1 ? ',' : ''}`),
      '        )',
      '    }',
      '}',
    ]
  }
  const content = lines(...swHeader(`Where ${resource.plural} are kept.`, imports), filterStruct, '', protocol, '', implementation)
  return { path: sourcePath(context.layout.resource(resource, 'repository'), name.repository), content: fileText(content) }
}
