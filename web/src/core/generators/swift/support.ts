/**
 * What every Swift project shares: the domain errors services throw (no HTTP codes), the pages lists are read in,
 * Patch (a field of an update: absent, or a value that may be nil), the rows the in-memory repositories keep,
 * and the unit of work over the repositories, with its database and in-memory versions.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { memoryRepository, repositoryType, sharedFile, sqlRepository, swFile, usesTimes, type Context } from './context.ts'
import { imports } from './swift.ts'

export function errorsFile(context: Context): GeneratedFile {
  return swFile(sharedFile(context, 'Errors'), '', [
    '/// What is wrong with one field.',
    'public struct FieldError: Sendable, Equatable {',
    '    public let field: String',
    '    public let message: String',
    '',
    '    public init(_ field: String, _ message: String) {',
    '        self.field = field',
    '        self.message = message',
    '    }',
    '}',
    '',
    '/// Every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them.',
    'public enum DomainError: Error, Sendable, Equatable, CustomStringConvertible {',
    '    /// No row has this key.',
    '    case notFound(entity: String, key: String)',
    '    /// The change clashes with what is stored: a unique value, a newer version, rows that depend on it.',
    '    case conflict(entity: String, reason: String, fields: [String])',
    '    /// The values break the rules of the table: missing, too long, out of range, pointing nowhere.',
    '    case validationFailed(entity: String, errors: [FieldError])',
    '',
    '    public var description: String {',
    '        switch self {',
    '        case .notFound(let entity, let key): "No \\(entity) has the key \\(key)"',
    '        case .conflict(let entity, let reason, _): "\\(entity): \\(reason)"',
    '        case .validationFailed(let entity, let errors):',
    '            "\\(entity): " + errors.map { "\\($0.field): \\($0.message)" }.joined(separator: "; ")',
    '        }',
    '    }',
    '',
    '    /// The fields a validation refused.',
    '    public var invalidFields: [String] {',
    '        if case .validationFailed(_, let errors) = self { errors.map(\\.field) } else { [] }',
    '    }',
    '}',
  ])
}

export function commonFile(context: Context): GeneratedFile {
  const body: string[] = []
  if (context.settings.paging === 'offset')
    body.push(
      '/// A page of a list: the rows from an offset, and how many there are in all.',
      'public struct Page<T: Sendable>: Sendable {',
      '    public let items: [T]',
      '    public let total: Int',
      '    public let offset: Int',
      '    public let limit: Int',
      '',
      '    public init(items: [T], total: Int, offset: Int, limit: Int) {',
      '        self.items = items',
      '        self.total = total',
      '        self.offset = offset',
      '        self.limit = limit',
      '    }',
      '',
      '    /// The same page with every row turned into something else.',
      '    public func map<R: Sendable>(_ transform: (T) throws -> R) rethrows -> Page<R> {',
      '        Page<R>(items: try items.map(transform), total: total, offset: offset, limit: limit)',
      '    }',
      '}',
      '',
    )
  if (context.settings.paging === 'cursor')
    body.push(
      '/// A page of a list read with a cursor: the rows after a key, and the key to read the next page from (nil on the last page).',
      'public struct CursorPage<T: Sendable, Key: Sendable>: Sendable {',
      '    public let items: [T]',
      '    public let next: Key?',
      '',
      '    public init(items: [T], next: Key?) {',
      '        self.items = items',
      '        self.next = next',
      '    }',
      '',
      '    /// The same page with every row turned into something else.',
      '    public func map<R: Sendable>(_ transform: (T) throws -> R) rethrows -> CursorPage<R, Key> {',
      '        CursorPage<R, Key>(items: try items.map(transform), next: next)',
      '    }',
      '}',
      '',
    )
  if (context.settings.services && context.settings.updates === 'patch')
    body.push(
      '/// A field of an update: absent (it keeps its value), or set to a value, which may be nil.',
      'public enum Patch<T: Sendable>: Sendable {',
      '    case absent',
      '    case set(T)',
      '',
      '    /// The value given, or nil when the field is absent.',
      '    public var given: T? {',
      '        switch self {',
      '        case .absent: nil',
      '        case .set(let value): value',
      '        }',
      '    }',
      '}',
      '',
    )
  if (context.settings.memoryRepositories)
    body.push(
      '/// The rows of a table kept in memory, shared by the copies of an in-memory repository.',
      'actor MemoryRows<Row: Sendable> {',
      '    private var rows: [Row] = []',
      '    private var lastId = 0',
      '',
      '    var all: [Row] { rows }',
      '',
      '    /// The next number of a key the database would number.',
      '    func nextId() -> Int {',
      '        lastId += 1',
      '        return lastId',
      '    }',
      '',
      '    /// Keeps a row, in place of the ones same tells apart.',
      '    func store(_ row: Row, replacing same: @Sendable (Row) -> Bool) {',
      '        rows.removeAll(where: same)',
      '        rows.append(row)',
      '    }',
      '',
      '    func remove(where same: @Sendable (Row) -> Bool) {',
      '        rows.removeAll(where: same)',
      '    }',
      '}',
      '',
      '/// Orders two values that may be nil, nil first.',
      'func less<T: Comparable>(_ a: T?, _ b: T?) -> Bool {',
      '    switch (a, b) {',
      '    case let (a?, b?): a < b',
      '    case (nil, _?): true',
      '    default: false',
      '    }',
      '}',
      '',
    )
  const postgres = context.settings.database === 'postgresql'
  if (usesTimes(context))
    body.push(
      '/// A time of the day, as a TIME column holds it: no date and no time zone. It goes to the database as "HH:MM:SS".',
      'public struct TimeOfDay: Sendable, Hashable, Comparable, Codable, CustomStringConvertible {',
      '    /// Microseconds since midnight.',
      '    public var microseconds: Int64',
      '',
      '    public init(microseconds: Int64) {',
      '        self.microseconds = microseconds',
      '    }',
      '',
      '    public init(hour: Int, minute: Int, second: Int = 0) {',
      '        self.microseconds = Int64((hour * 60 + minute) * 60 + second) * 1_000_000',
      '    }',
      '',
      '    public var description: String {',
      '        let seconds = microseconds / 1_000_000',
      '        return String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)',
      '    }',
      '',
      '    public init(from decoder: any Decoder) throws {',
      '        let text = try decoder.singleValueContainer().decode(String.self)',
      '        let parts = text.split(separator: ":").map { Double($0) ?? 0 }',
      '        guard parts.count >= 2 else {',
      '            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a time of the day: \\(text)"))',
      '        }',
      '        self.microseconds = Int64(((parts[0] * 60 + parts[1]) * 60 + (parts.count > 2 ? parts[2] : 0)) * 1_000_000)',
      '    }',
      '',
      '    public func encode(to encoder: any Encoder) throws {',
      '        var container = encoder.singleValueContainer()',
      '        try container.encode(description)',
      '    }',
      '',
      '    public static func < (lhs: TimeOfDay, rhs: TimeOfDay) -> Bool {',
      '        lhs.microseconds < rhs.microseconds',
      '    }',
      '}',
      '',
      ...(postgres
        ? [
            '/// PostgreSQL keeps a TIME as the microseconds since midnight.',
            'extension TimeOfDay: PostgresNonThrowingEncodable, PostgresDecodable {',
            '    public static var psqlType: PostgresDataType { .time }',
            '    public static var psqlFormat: PostgresFormat { .binary }',
            '',
            '    public func encode<JSONEncoder: PostgresJSONEncoder>(into byteBuffer: inout ByteBuffer, context: PostgresEncodingContext<JSONEncoder>) {',
            '        byteBuffer.writeInteger(microseconds)',
            '    }',
            '',
            '    public init<JSONDecoder: PostgresJSONDecoder>(',
            '        from buffer: inout ByteBuffer, type: PostgresDataType, format: PostgresFormat, context: PostgresDecodingContext<JSONDecoder>',
            '    ) throws {',
            '        guard type == .time, format == .binary, let value = buffer.readInteger(as: Int64.self) else {',
            '            throw PostgresDecodingError.Code.typeMismatch',
            '        }',
            '        self.init(microseconds: value)',
            '    }',
            '}',
            '',
          ]
        : []),
    )
  body.pop()
  const header = usesTimes(context) ? imports('Foundation', ...(postgres ? ['NIOCore', 'PostgresNIO'] : [])) : ''
  return swFile(sharedFile(context, 'Common'), header, body)
}

const URLS: Record<string, string> = {
  postgresql: 'postgres://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app?ssl-mode=DISABLED',
  mariadb: 'mysql://app:app@localhost:3306/app?ssl-mode=DISABLED',
  sqlite: 'sqlite://app.db',
}

export const defaultUrl = (context: Context) => context.orm.url ?? URLS[context.settings.database] ?? URLS.postgresql

const HOW = {
  operation: 'Each service operation runs in transaction(): committed when it ends, rolled back when it throws.',
  caller: 'Services never commit: whoever holds the database opens and ends its transaction; transaction() only groups the code.',
  repository: 'Every repository write is committed at once; transaction() only groups the code.',
}

/** UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork. */
export function unitOfWorkFile(context: Context): GeneratedFile {
  const settings = context.settings
  const { holder } = context.orm
  const operation = settings.transactions === 'operation'
  const signature = 'func transaction<T: Sendable>(_ work: @escaping @Sendable (any UnitOfWork) async throws -> T) async throws -> T'
  return swFile(sharedFile(context, 'UnitOfWork'), imports(...context.orm.holder.modules), [
    `/// What services depend on: a repository per table and a transaction. ${HOW[settings.transactions]}`,
    'public protocol UnitOfWork: Sendable {',
    ...context.tables.map((info) => `    var ${info.attr}: ${repositoryType(context, info)} { get }`),
    '',
    '    /// Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws.',
    `    ${signature}`,
    '}',
    '',
    '/// The repositories over one database, and its transaction.',
    'public struct SqlUnitOfWork: UnitOfWork {',
    `    public let db: ${holder.type}`,
    '',
    `    public init(db: ${holder.type}) {`,
    '        self.db = db',
    '    }',
    ...context.tables.flatMap((info) => [
      '',
      `    public var ${info.attr}: ${repositoryType(context, info)} { ${sqlRepository(info)}(db: db) }`,
    ]),
    '',
    operation
      ? '    /// Joins the transaction already open, or opens one.'
      : `    /// ${settings.transactions === 'caller' ? 'The transaction belongs to whoever holds the database' : 'Every write is committed at once'}: this only groups the code.`,
    `    public ${signature} {`,
    operation ? `        ${context.orm.transaction}` : '        try await work(self)',
    '    }',
    '}',
    ...(settings.memoryRepositories
      ? [
          '',
          '/// The in-memory repositories, for tests and for trying the services without a database.',
          'public final class MemoryUnitOfWork: UnitOfWork {',
          ...context.tables.map((info) => `    public let ${info.attr}: ${repositoryType(context, info)} = ${memoryRepository(info)}()`),
          '',
          '    public init() {}',
          '',
          '    /// Memory has no transactions: changes are kept as they are made.',
          `    public ${signature} {`,
          '        try await work(self)',
          '    }',
          '}',
        ]
      : []),
  ])
}

/** MySQL's driver would keep bytes as JSON. */
export const usesMysqlData = (context: Context) =>
  ['mysql', 'mariadb'].includes(context.settings.database) &&
  context.tables.some((info) => info.columns.some((column) => column.sw === 'Data'))

export const MYSQL_DATA = [
  '',
  '/// Bytes go to the database and come back as they are.',
  'extension Data: @retroactive MySQLDataConvertible {',
  '    public init?(mysqlData: MySQLData) {',
  '        guard let buffer = mysqlData.buffer else { return nil }',
  '        self = Data(buffer.readableBytesView)',
  '    }',
  '',
  '    public var mysqlData: MySQLData? {',
  '        MySQLData(type: .blob, format: .binary, buffer: ByteBuffer(bytes: self), isUnsigned: true)',
  '    }',
  '}',
]
