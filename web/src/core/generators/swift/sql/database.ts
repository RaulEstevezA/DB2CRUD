/**
 * The database layer of a Swift project without an ORM: `AppDatabase.swift`, with the pool of connections to DATABASE_URL, Db
 * (what the repositories run their SQL on: the pool, or the connection of a transaction) and the helpers they use; how each
 * column is selected, read and written; and the entities, plain structs with a property per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { quoteName, typeSql } from '../../../schema/ddl.ts'
import type { Dialect } from '../../../schema/types.ts'
import { fileOf, sharedFile, swFile, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { defaultUrl, MYSQL_DATA, usesMysqlData } from '../support.ts'
import { imports, swString } from '../swift.ts'

const isMysql = (database: Dialect) => database === 'mysql' || database === 'mariadb'

/** Around the Swift code inside the text of a statement, until it is written as an interpolation. */
const MARK = '\u0001'

/** Swift code inside a statement: `bind: id`. */
export const code = (text: string) => `${MARK}${text}${MARK}`

/** The Swift literal of a statement, with its code as interpolations. */
export function statement(sql: string): string {
  const parts = sql.split(MARK).map((part, index) => (index % 2 === 1 ? `\\(${part})` : swString(part).slice(1, -1)))
  return `"${parts.join('')}"`
}

/** The driver of each database: its module, its connections and its configuration. */
export function driverOf(context: Context): { module: string; source: string; configuration: string; argument: string } {
  const database = context.settings.database
  if (database === 'sqlite')
    return { module: 'SQLiteKit', source: 'SQLiteConnectionSource', configuration: 'SQLiteConfiguration', argument: 'configuration' }
  if (isMysql(database))
    return { module: 'MySQLKit', source: 'MySQLConnectionSource', configuration: 'MySQLConfiguration', argument: 'configuration' }
  return {
    module: 'PostgresKit',
    source: 'PostgresConnectionSource',
    configuration: 'SQLPostgresConfiguration',
    argument: 'sqlConfiguration',
  }
}

/** How a URL becomes the configuration of the driver. */
function configurationLines(database: Dialect): string[] {
  if (database === 'sqlite')
    return [
      '        self.init(configuration: SQLiteConfiguration(storage: .file(path: url.hasPrefix("sqlite://") ? String(url.dropFirst(9)) : url)))',
    ]
  if (isMysql(database))
    return [
      '        guard let configuration = MySQLConfiguration(url: url) else { throw URLError(.badURL) }',
      '        self.init(configuration: configuration)',
    ]
  return ['        try self.init(configuration: SQLPostgresConfiguration(url: url))']
}

/** The transaction of Db: MySQL opens it outside its prepared statements. */
function transactionLines(database: Dialect): string[] {
  const signature = '    public func transaction<T: Sendable>(_ work: @escaping @Sendable (Db) async throws -> T) async throws -> T {'
  const ending = (run: (sql: string) => string) => [
    '            do {',
    '                let result = try await work(Db(sql: session, inTransaction: true))',
    `                ${run('COMMIT')}`,
    '                return result',
    '            } catch {',
    `                ${run('ROLLBACK').replace('try await', 'try? await')}`,
    '                throw error',
    '            }',
  ]
  if (isMysql(database))
    return [
      signature,
      '        guard let pool else { return try await work(self) }',
      '        return try await pool.withConnection(logger: sql.logger) { connection in',
      '            connection.eventLoop.makeFutureWithTask {',
      ...[
        '            let session = connection.sql()',
        '            _ = try await connection.simpleQuery("START TRANSACTION").get()',
        ...ending((sql) => `_ = try await connection.simpleQuery("${sql}").get()`),
      ].map((line) => `    ${line}`),
      '            }',
      '        }.get()',
      '    }',
    ]
  return [
    signature,
    '        if inTransaction { return try await work(self) }',
    '        return try await sql.withSession { session in',
    '            try await session.raw("BEGIN").run()',
    ...ending((sql) => `try await session.raw("${sql}").run()`),
    '        }',
    '    }',
  ]
}

/** Whether the database refused a write, from the error of its driver. */
function refusalLines(database: Dialect): string[] {
  const head = [
    '/// Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules.',
    'func isRefusal(_ error: any Error) -> Bool {',
  ]
  if (database === 'postgresql')
    return [
      ...head,
      '    // SQLSTATE class 23: integrity constraint violation',
      '    (error as? PSQLError)?.serverInfo?[.sqlState]?.hasPrefix("23") == true',
      '}',
    ]
  if (isMysql(database))
    return [
      ...head,
      '    switch error as? MySQLError {',
      '    case .duplicateEntry: true',
      '    // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)',
      '    case .server(let packet): packet.sqlState?.hasPrefix("23") == true || [3819, 4025].contains(packet.errorCode.rawValue)',
      '    default: false',
      '    }',
      '}',
    ]
  return [...head, '    (error as? SQLiteError).map { "\\($0.reason)".hasPrefix("constraint") } ?? false', '}']
}

/** Whether a table of the project has a column of this type. */
const uses = (context: Context, sw: string) => context.tables.some((info) => info.columns.some((column) => column.sw === sw))

/** SQLite keeps dates as their text, in UTC. */
const DATES = [
  '',
  '/// A date as the text SQLite keeps, in UTC: "2026-01-31 12:00:00.000000", or only its day.',
  'func sqlText(_ date: Date, day: Bool = false) -> String {',
  '    let micros = Int64((date.timeIntervalSince1970 * 1_000_000).rounded())',
  '    let fraction = ((micros % 1_000_000) + 1_000_000) % 1_000_000',
  '    var calendar = Calendar(identifier: .gregorian)',
  '    calendar.timeZone = TimeZone(secondsFromGMT: 0)!',
  '    let parts = calendar.dateComponents(',
  '        [.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: Double((micros - fraction) / 1_000_000)))',
  '    let text = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)',
  '    return day ? text : text + String(format: " %02d:%02d:%02d.%06d", parts.hour!, parts.minute!, parts.second!, Int(fraction))',
  '}',
  '',
  '/// The date of a text SQLite keeps; one without its zone is in UTC, and a number is the seconds since 1970.',
  'func sqlDate(_ text: String) -> Date? {',
  '    if let seconds = Double(text) { return Date(timeIntervalSince1970: seconds) }',
  '    let halves = text.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "T" })',
  '    let days = halves[0].split(separator: "-").compactMap { Int($0) }',
  '    guard days.count == 3 else { return nil }',
  '    var time = halves.count > 1 ? String(halves[1]) : "00:00:00"',
  '    var offset = 0',
  '    if time.hasSuffix("Z") {',
  '        time.removeLast()',
  '    } else if let sign = time.lastIndex(where: { $0 == "+" || $0 == "-" }) {',
  '        let digits = time[time.index(after: sign)...].filter(\\.isNumber)',
  '        offset = ((Int(digits.prefix(2)) ?? 0) * 60 + (Int(digits.dropFirst(2)) ?? 0)) * (time[sign] == "-" ? -60 : 60)',
  '        time = String(time[..<sign])',
  '    }',
  '    let clock = time.split(separator: ":").compactMap { Double($0) }',
  '    guard clock.count >= 2 else { return nil }',
  '    var calendar = Calendar(identifier: .gregorian)',
  '    calendar.timeZone = TimeZone(secondsFromGMT: 0)!',
  '    guard let midnight = calendar.date(from: DateComponents(year: days[0], month: days[1], day: days[2])) else { return nil }',
  '    return midnight.addingTimeInterval((clock[0] * 60 + clock[1]) * 60 + (clock.count > 2 ? clock[2] : 0) - Double(offset))',
  '}',
]

/** SQLiteKit has no database over a pool of its own. */
const POOLED_SQLITE = [
  '/// SQLite through the connections of a pool.',
  'private struct PooledSQLite: SQLiteDatabase {',
  '    nonisolated(unsafe) let pool: EventLoopGroupConnectionPool<SQLiteConnectionSource>',
  '    let logger: Logger',
  '',
  '    var eventLoop: any EventLoop { pool.eventLoopGroup.any() }',
  '',
  '    func query(',
  '        _ query: String, _ binds: [SQLiteData], logger: Logger, _ onRow: @escaping @Sendable (SQLiteRow) -> Void',
  '    ) -> EventLoopFuture<Void> {',
  '        withConnection { $0.query(query, binds, logger: logger, onRow) }',
  '    }',
  '',
  '    func withConnection<T>(_ closure: @escaping @Sendable (SQLiteConnection) -> EventLoopFuture<T>) -> EventLoopFuture<T> {',
  '        pool.withConnection(logger: logger, closure)',
  '    }',
  '}',
  '',
]

/** `AppDatabase.swift`: the pool, Db, and the helpers of the repositories. */
export function databaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const mysql = isMysql(database)
  const driver = driverOf(context)
  const throwing = database === 'sqlite' ? '' : ' throws'
  const inserts = mysql && context.tables.some((info) => info.queries.some((item) => item.kind === 'insert'))
  return swFile(
    sharedFile(context, 'AppDatabase'),
    imports(
      'AsyncKit',
      'Foundation',
      'Logging',
      'NIOPosix',
      'SQLKit',
      driver.module,
      ...(database === 'sqlite' || usesMysqlData(context) ? ['NIOCore'] : []),
    ),
    [
      `/// The database DATABASE_URL names, through ${driver.module}. It never migrates: the database already exists.`,
      'public final class AppDatabase: Sendable {',
      `    public static let defaultURL = ${swString(defaultUrl(context))}`,
      '',
      '    // The pool locks what it keeps, though AsyncKit does not declare it Sendable',
      `    private nonisolated(unsafe) let pool: EventLoopGroupConnectionPool<${driver.source}>`,
      '    /// What the repositories run their SQL on.',
      '    public let database: Db',
      '',
      '    /// The database at url (DATABASE_URL, or defaultURL, by default).',
      `    public convenience init(url: String = ProcessInfo.processInfo.environment["DATABASE_URL"] ?? AppDatabase.defaultURL)${throwing} {`,
      ...configurationLines(database),
      '    }',
      '',
      '    /// The database a configuration names.',
      `    public init(configuration: ${driver.configuration}) {`,
      `        let source = ${driver.source}(${driver.argument}: configuration)`,
      '        let pool = EventLoopGroupConnectionPool(source: source, on: MultiThreadedEventLoopGroup.singleton)',
      '        self.pool = pool',
      database === 'sqlite'
        ? '        self.database = Db(sql: PooledSQLite(pool: pool, logger: Logger(label: "app.database")).sql())'
        : `        self.database = Db(sql: pool.database(logger: Logger(label: "app.database")).sql()${mysql ? ', pool: pool' : ''})`,
      '    }',
      '',
      '    /// Closes the connections.',
      '    public func shutdown() async {',
      '        try? await pool.shutdownAsync()',
      '    }',
      '}',
      '',
      ...(database === 'sqlite' ? POOLED_SQLITE : []),
      '/// What the repositories run their SQL on: the pool, or the connection of a transaction.',
      'public struct Db: Sendable {',
      '    public let sql: any SQLDatabase',
      ...(mysql
        ? [
            '    /// Where transactions are opened; nil inside one.',
            '    // The pool locks what it keeps, though AsyncKit does not declare it Sendable',
            `    private nonisolated(unsafe) let pool: EventLoopGroupConnectionPool<${driver.source}>?`,
            '',
            `    init(sql: any SQLDatabase, pool: EventLoopGroupConnectionPool<${driver.source}>? = nil, inTransaction: Bool = false) {`,
            '        self.sql = sql',
            '        self.pool = inTransaction ? nil : pool',
            '    }',
          ]
        : [
            '    private let inTransaction: Bool',
            '',
            '    init(sql: any SQLDatabase, inTransaction: Bool = false) {',
            '        self.sql = sql',
            '        self.inTransaction = inTransaction',
            '    }',
          ]),
      '',
      '    /// Runs work in a transaction, committed when it ends and undone when it throws; it joins the one already open.',
      ...transactionLines(database),
      ...(inserts
        ? [
            '',
            '    /// Runs an insert; the id the database gave the new row, when it numbers them.',
            '    func insert(_ query: SQLQueryString) async throws -> Int? {',
            '        try await sql.withSession { session in',
            '            try await session.raw(query).run()',
            '            return try await session.raw("SELECT LAST_INSERT_ID() AS id").first()?.decode(column: "id", as: Int.self)',
            '        }',
            '    }',
          ]
        : []),
      '}',
      '',
      '/// A value that may be nil, bound to a statement.',
      'func bound<T: Encodable & Sendable>(_ value: T?) -> any SQLExpression {',
      '    if let value { SQLBind(value) } else { SQLLiteral.null }',
      '}',
      '',
      'extension SQLRow {',
      '    /// The value of a column, or nil.',
      '    func optional<T: Decodable>(_ column: String, as type: T.Type) throws -> T? {',
      '        try decodeNil(column: column) ? nil : decode(column: column, as: type)',
      '    }',
      '}',
      '',
      ...refusalLines(database),
      ...(database === 'sqlite' && uses(context, 'Date') ? DATES : []),
      ...(usesMysqlData(context) ? MYSQL_DATA : []),
    ],
  )
}

/** The kinds the drivers take and give as text only through a cast of PostgreSQL. */
const AS_TEXT = new Set(['enum', 'json', 'array', 'unknown'])

/** `"status"::text AS "status"`: a column as a read selects it. */
export function selected(context: Context, column: ColumnInfo): string {
  const database = context.settings.database
  const name = quoteName(database, column.column.name)
  const type = column.column.type
  if (database === 'postgresql') {
    if (AS_TEXT.has(type.kind)) return `${name}::text AS ${name}`
    return type.kind === 'time' && type.timezone ? `${name}::time AS ${name}` : name
  }
  if (database === 'sqlite') return ['Decimal', 'Date', 'TimeOfDay'].includes(column.sw) ? `CAST(${name} AS TEXT) AS ${name}` : name
  return type.kind === 'json' || type.kind === 'array' || column.sw === 'TimeOfDay' ? `CAST(${name} AS CHAR) AS ${name}` : name
}

/** A column of a row, as the property of the entity keeps it. */
export function readColumn(context: Context, column: ColumnInfo): string {
  const database = context.settings.database
  const read = (type: string) => `try row.optional(${swString(column.column.name)}, as: ${type}.self)`
  if (column.sw === 'UUID' && database !== 'postgresql') return `${read('String')}.flatMap { UUID(uuidString: $0) }`
  if (column.sw === 'Decimal' && database === 'sqlite') return `${read('String')}.flatMap { Decimal(string: $0) }`
  if (column.sw === 'Date' && database === 'sqlite') return `${read('String')}.flatMap { sqlDate($0) }`
  return read(column.sw)
}

/** A value of the entity's type, as the driver takes it. */
function driverValue(context: Context, column: ColumnInfo, value: string): string {
  const database = context.settings.database
  if (database === 'postgresql') return value
  if (column.sw === 'UUID') return `${value}.uuidString.lowercased()`
  if (column.sw === 'TimeOfDay') return `${value}.description`
  if (database !== 'sqlite') return value
  if (column.sw === 'Decimal') return `"\\(${value})"`
  if (column.sw === 'Date') return column.column.type.kind === 'date' ? `sqlText(${value}, day: true)` : `sqlText(${value})`
  return value
}

/** A bound value with what the database needs to take it as the type of the column. */
function typed(context: Context, column: ColumnInfo, bind: string): string {
  const type = column.column.type
  // The driver of MySQL sends the time too
  if (isMysql(context.settings.database)) return type.kind === 'date' ? `CAST(${bind} AS DATE)` : bind
  if (context.settings.database !== 'postgresql') return bind
  // The driver sends a point in time: a column without a zone keeps it in UTC
  if (type.kind === 'date') return `(${bind}::timestamptz AT TIME ZONE 'UTC')::date`
  if (type.kind === 'datetime') return type.timezone ? bind : `(${bind}::timestamptz AT TIME ZONE 'UTC')`
  if (type.kind === 'enum') {
    const item = context.schema.enums.find((candidate) => candidate.name === type.name)
    return item?.storage === 'native' ? `${bind}::${quoteName('postgresql', type.name)}` : bind
  }
  return AS_TEXT.has(type.kind) ? `${bind}::${typeSql(context.schema, 'postgresql', type)}` : bind
}

/** A value that is not nil, inside a statement. */
export const bindValue = (context: Context, column: ColumnInfo, value: string) =>
  typed(context, column, code(`bind: ${driverValue(context, column, value)}`))

/** A value that may be nil, inside a statement. */
export function bindOptional(context: Context, column: ColumnInfo, value: string): string {
  const converted = driverValue(context, column, '$0')
  return typed(context, column, code(converted === '$0' ? `bound(${value})` : `bound(${value}.map { ${converted} })`))
}

/** The entity of a table: a struct with a property per column, nil until it is set or read. */
export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const comment = info.table.comment ? `: ${info.table.comment}` : ''
  const kept = context.settings.database === 'postgresql' ? ' (an array literal of PostgreSQL)' : ' (JSON)'
  const properties = info.columns.flatMap((column) => [
    ...(column.column.type.kind === 'unknown'
      ? [`    // TODO: "${column.column.type.sql}" has no Swift type here; it is kept as its text`]
      : []),
    ...(column.column.type.kind === 'array' ? [`    // TODO: "${column.column.type.sql}" is kept as its text${kept}`] : []),
    `    public var ${column.prop}: ${column.sw}?`,
  ])
  return swFile(fileOf(context, info, 'entity', info.entity), imports('Foundation'), [
    `/// A row of the "${info.name}" table${comment}. The repositories read and write it with SQL; a property stays nil until it is set or read.`,
    `public struct ${info.entity}: Sendable, Equatable {`,
    ...properties,
    '',
    `    public init(${info.columns.map((column) => `${column.prop}: ${column.sw}? = nil`).join(', ')}) {`,
    ...info.columns.map((column) => `        self.${column.prop} = ${column.prop}`),
    '    }',
    '}',
  ])
}
