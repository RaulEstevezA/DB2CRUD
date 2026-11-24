/**
 * Swift + FluentKit 1, without Vapor (Strategy of orm.ts): entities and Fluent models, repositories that query them, a unit
 * of work over Fluent's transactions, and tests on a database Fluent's schema builder creates.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbColumn } from '../../../schema/types.ts'
import { findInfo, ind, sharedFile, swFile, usesTimes, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import type { SwiftOrm } from '../orm.ts'
import { defaultUrl, MYSQL_DATA, usesMysqlData } from '../support.ts'
import { imports, swString } from '../swift.ts'
import { NAMES } from '../tests.ts'
import { entityFile, modelFile } from './entities.ts'
import { fluentBody, toEntityFunction, usesSql } from './repository.ts'

const VERSIONS = {
  fluentKit: '1.57.0',
  postgres: '2.14.1',
  mysql: '4.8.0',
  sqlite: '4.9.0',
  nio: '2.105.0',
  postgresNio: '1.33.3',
  log: '1.17.2',
}

const PACKAGES: Record<string, { name: string; version: string }> = {
  FluentPostgresDriver: { name: 'fluent-postgres-driver', version: VERSIONS.postgres },
  FluentMySQLDriver: { name: 'fluent-mysql-driver', version: VERSIONS.mysql },
  FluentSQLiteDriver: { name: 'fluent-sqlite-driver', version: VERSIONS.sqlite },
}

const DRIVERS: Record<string, { module: string; factory: (url: string) => string; throws: boolean }> = {
  postgresql: { module: 'FluentPostgresDriver', factory: (url) => `.postgres(url: ${url})`, throws: true },
  mysql: { module: 'FluentMySQLDriver', factory: (url) => `.mysql(url: ${url})`, throws: true },
  mariadb: { module: 'FluentMySQLDriver', factory: (url) => `.mysql(url: ${url})`, throws: true },
  sqlite: {
    module: 'FluentSQLiteDriver',
    factory: (url) => `.sqlite(.init(storage: .file(path: ${url}.hasPrefix("sqlite://") ? String(${url}.dropFirst(9)) : ${url})))`,
    throws: false,
  },
}

const driverOf = (context: Context) => DRIVERS[context.settings.database] ?? DRIVERS.postgresql

/** `AppDatabase`: the database DATABASE_URL names, through Fluent. */
function databaseFile(context: Context): GeneratedFile {
  const driver = driverOf(context)
  return swFile(sharedFile(context, 'AppDatabase'), imports('FluentKit', driver.module, 'Foundation', 'Logging', 'NIOCore', 'NIOPosix'), [
    '/// The database DATABASE_URL names, through Fluent. It never migrates: the database already exists.',
    'public final class AppDatabase: Sendable {',
    `    public static let defaultURL = ${swString(defaultUrl(context))}`,
    '',
    '    private let databases: Databases',
    '    /// What the repositories run their queries on.',
    '    public let database: any Database',
    '',
    '    /// The database at url (DATABASE_URL, or defaultURL, by default).',
    `    public convenience init(url: String = ProcessInfo.processInfo.environment["DATABASE_URL"] ?? AppDatabase.defaultURL)${driver.throws ? ' throws' : ''} {`,
    `        ${driver.throws ? 'try ' : ''}self.init(configuration: ${driver.factory('url')})`,
    '    }',
    '',
    '    /// The database a configuration of Fluent names.',
    '    public init(configuration: DatabaseConfigurationFactory) {',
    '        let databases = Databases(threadPool: .singleton, on: MultiThreadedEventLoopGroup.singleton)',
    '        databases.use(configuration, as: DatabaseID(string: "app"))',
    '        self.databases = databases',
    '        self.database = databases.database(logger: Logger(label: "app.database"), on: MultiThreadedEventLoopGroup.singleton.any())!',
    '    }',
    '',
    '    /// Closes the connections.',
    '    public func shutdown() async {',
    '        await databases.shutdownAsync()',
    '    }',
    '}',
    ...(usesMysqlData(context) ? MYSQL_DATA : []),
  ])
}

/** The tables in the order they can be created: the rows they point to first. */
function creationOrder(tables: TableInfo[]): TableInfo[] {
  const order: TableInfo[] = []
  const visit = (info: TableInfo, path: Set<string>) => {
    if (order.includes(info) || path.has(info.name)) return
    path.add(info.name)
    for (const key of info.table.foreignKeys) {
      const parent = tables.find((item) => item.name === key.references.table)
      if (parent && parent !== info) visit(parent, path)
    }
    order.push(info)
  }
  for (const info of tables) visit(info, new Set())
  return order
}

const sqlQuote = (text: string) => `'${text.replace(/'/g, "''")}'`

/** The data type of a column in Fluent's schema builder, as the database has it. */
function dataType(context: Context, column: DbColumn): string {
  const database = context.settings.database
  const type = column.type
  const raw = (sql: string) => `.sql(unsafeRaw: ${swString(sql)})`
  if (type.kind === 'enum' && database !== 'sqlite') {
    const item = context.schema.enums.find((candidate) => candidate.name === type.name)
    if (item?.storage === 'native')
      return database === 'postgresql' ? raw(`"${item.name}"`) : raw(`ENUM(${item.values.map(sqlQuote).join(', ')})`)
  }
  switch (type.kind) {
    case 'integer':
      return type.bits === 16 ? '.int16' : type.bits === 64 ? '.int64' : '.int32'
    case 'decimal':
      return raw(`DECIMAL(${type.precision ?? 10}, ${type.scale ?? 0})`)
    case 'float':
      return type.bits === 32 ? '.float' : '.double'
    case 'boolean':
      return '.bool'
    case 'text':
      return type.length === undefined ? '.string' : raw(`${type.fixed ? 'CHAR' : 'VARCHAR'}(${type.length})`)
    case 'enum': {
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      return raw(`VARCHAR(${Math.max(1, ...values.map((value) => value.length))})`)
    }
    case 'date':
      return '.date'
    case 'time':
      return '.time'
    case 'datetime':
      return type.timezone && database === 'postgresql' ? raw('TIMESTAMPTZ') : '.datetime'
    case 'uuid':
      return '.uuid'
    case 'binary':
      // MySQL has no keys on columns without a length
      return type.length !== undefined && (database === 'mysql' || database === 'mariadb') ? raw(`VARBINARY(${type.length})`) : '.data'
    default:
      return '.string'
  }
}

/** The constraints of a column in Fluent's schema builder: its key, null, its default. */
function constraints(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const db = column.column
  const result: string[] = []
  const single = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  if (single) result.push(`.identifier(auto: ${db.generated === 'identity' ? 'true' : 'false'})`)
  else if (!db.nullable) result.push('.required')
  const raw = (sql: string) => result.push(`.sql(unsafeRaw: ${swString(sql)})`)
  if (db.generated === 'now' || db.generated === 'onUpdateNow')
    // Fluent writes a datetime as DATETIME(6) on MySQL, whose default must have the same precision
    raw(
      db.type.kind === 'date'
        ? 'DEFAULT CURRENT_DATE'
        : ['mysql', 'mariadb'].includes(context.settings.database) && dataType(context, db) === '.datetime'
          ? 'DEFAULT CURRENT_TIMESTAMP(6)'
          : 'DEFAULT CURRENT_TIMESTAMP',
    )
  else if (typeof db.generated === 'object') raw(`GENERATED ALWAYS AS (${db.generated.computed}) STORED`)
  else if (db.default?.kind === 'literal' && db.default.value !== null) {
    const value = db.default.value
    raw(`DEFAULT ${typeof value === 'string' ? sqlQuote(value) : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)}`)
  } else if (db.default?.kind === 'expression') raw(`DEFAULT ${db.default.sql}`)
  return result
}

const ACTIONS: Record<string, string> = {
  cascade: '.cascade',
  'set null': '.setNull',
  'set default': '.setDefault',
  restrict: '.restrict',
  'no action': '.noAction',
}

/** The columns of a foreign key in Fluent's schema builder: a name, or a list of them. */
const fields = (names: string[]) => (names.length > 1 ? `[${names.map(swString).join(', ')}]` : swString(names[0]))

/** The schema builder of a table, as the database has it. */
function createTable(context: Context, info: TableInfo): string[] {
  const { table } = info
  const space = table.schema && context.settings.database === 'postgresql' ? `, space: ${swString(table.schema)}` : ''
  const lines = [`try await db.schema(${swString(table.name)}${space})`]
  for (const column of info.columns)
    lines.push(
      `    .field(${[swString(column.column.name), dataType(context, column.column), ...constraints(context, info, column)].join(', ')})`,
    )
  if (table.primaryKey && table.primaryKey.length > 1)
    lines.push(`    .compositeIdentifier(over: ${table.primaryKey.map(swString).join(', ')})`)
  for (const unique of table.uniques)
    lines.push(`    .unique(on: ${unique.columns.map(swString).join(', ')}${unique.name ? `, name: ${swString(unique.name)}` : ''})`)
  for (const key of table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent || !parent.writesEntity) continue
    const parentSpace =
      parent.table.schema && context.settings.database === 'postgresql' ? `, inSpace: ${swString(parent.table.schema)}` : ''
    lines.push(
      `    .foreignKey(${fields(key.columns)}, references: ${swString(parent.name)}${parentSpace}, ${fields(key.references.columns)}, onDelete: ${ACTIONS[key.onDelete ?? 'no action']}${key.name ? `, name: ${swString(key.name)}` : ''})`,
    )
  }
  lines.push('    .create()')
  return lines
}

function testDatabase(context: Context) {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const postgres = database === 'postgresql'
  const tables = context.tables.filter((info) => info.writesEntity)
  const quote = (name: string) => (database === 'mysql' || database === 'mariadb' ? `\`${name}\`` : `"${name}"`)
  const qualifiedName = (info: TableInfo) =>
    info.table.schema && postgres ? `${quote(info.table.schema)}.${quote(info.name)}` : quote(info.name)
  const schemas = postgres ? [...new Set(context.tables.map((info) => info.table.schema).filter((name): name is string => !!name))] : []
  const enums = postgres
    ? context.schema.enums.filter(
        (item) =>
          item.storage === 'native' &&
          context.tables.some((info) =>
            info.columns.some((column) => column.column.type.kind === 'enum' && column.column.type.name === item.name),
          ),
      )
    : []
  const run = (sql: string) => `try await sql.raw(${swString(sql)}).run()`
  const order = creationOrder(tables)
  const check = postgres ? 'SELECT current_database() AS value' : sqlite ? 'SELECT sqlite_version() AS value' : 'SELECT DATABASE() AS value'
  const open = [
    ...(sqlite
      ? [
          '        let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"]',
          '        let app = if let url { AppDatabase(url: url) } else { AppDatabase(configuration: .sqlite(.memory)) }',
        ]
      : [
          '        // The tables are written for one kind of database: the tests cannot fall back to SQLite',
          `        let url = try #require(ProcessInfo.processInfo.environment["TEST_DATABASE_URL"], ${swString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)})`,
          '        let app = try AppDatabase(url: url)',
        ]),
  ]
  const recreate = [
    '    /// Drops every table, the rows that point to others first, and creates them again as the database has them.',
    '    private static func recreate(_ db: any Database) async throws {',
    '        let sql = db as! any SQLDatabase',
    ...ind(
      [
        ...schemas.map((name) => run(`DROP SCHEMA IF EXISTS ${quote(name)} CASCADE`)),
        ...[...order].reverse().map((info) => run(`DROP TABLE IF EXISTS ${qualifiedName(info)}${postgres ? ' CASCADE' : ''}`)),
        ...enums.flatMap((item) => [
          run(`DROP TYPE IF EXISTS ${quote(item.name)} CASCADE`),
          run(`CREATE TYPE ${quote(item.name)} AS ENUM (${item.values.map(sqlQuote).join(', ')})`),
        ]),
        ...schemas.map((name) => run(`CREATE SCHEMA ${quote(name)}`)),
        ...order.flatMap((info) => createTable(context, info)),
      ],
      8,
    ),
    '    }',
  ]
  return {
    modules: ['FluentKit', 'FluentSQL', ...(sqlite ? [driverOf(context).module] : [])],
    open,
    recreate,
    check: `(uow.db as! any SQLDatabase).raw(${swString(check)}).all()`,
  }
}

function packages(context: Context) {
  const driver = driverOf(context).module
  const driverPackage = PACKAGES[driver]
  const postgresTimes = context.settings.database === 'postgresql' && usesTimes(context)
  const product = (name: string, pkg: string) => `.product(name: "${name}", package: "${pkg}")`
  const urls = [
    `.package(url: "https://github.com/vapor/fluent-kit.git", from: "${VERSIONS.fluentKit}"),`,
    `.package(url: "https://github.com/vapor/${driverPackage.name}.git", from: "${driverPackage.version}"),`,
    `.package(url: "https://github.com/apple/swift-nio.git", from: "${VERSIONS.nio}"),`,
    `.package(url: "https://github.com/apple/swift-log.git", from: "${VERSIONS.log}"),`,
    // TimeOfDay says how PostgreSQL keeps it
    ...(postgresTimes ? [`.package(url: "https://github.com/vapor/postgres-nio.git", from: "${VERSIONS.postgresNio}"),`] : []),
  ]
  const products = [
    product('FluentKit', 'fluent-kit'),
    product('FluentSQL', 'fluent-kit'),
    product(driver, driverPackage.name),
    product('NIOCore', 'swift-nio'),
    product('NIOPosix', 'swift-nio'),
    product('Logging', 'swift-log'),
    ...(postgresTimes ? [product('PostgresNIO', 'postgres-nio')] : []),
  ]
  const testProducts = [product('FluentKit', 'fluent-kit'), product('FluentSQL', 'fluent-kit'), product(driver, driverPackage.name)]
  return { packages: urls, products, testProducts }
}

export const fluentOrm: SwiftOrm = {
  id: 'fluent',
  label: 'Fluent',
  holder: { type: 'any Database', optional: '(any Database)?', modules: ['FluentKit'] },
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}"' : '"[]"'),
  databaseFile,
  entityFiles: (context, info) => [entityFile(context, info), modelFile(context, info)],
  repository: {
    modules: (context, info) => ['FluentKit', ...(usesSql(context, info) ? ['FluentSQL'] : [])],
    body: fluentBody,
    refusal: 'let error as any DatabaseError where error.isConstraintFailure',
    functions: (context, info) => toEntityFunction(context, info),
  },
  transaction: 'try await db.transaction { transaction in try await work(SqlUnitOfWork(db: transaction)) }',
  testDatabase,
  packages,
  readme: {
    intro: `entities and Fluent ${VERSIONS.fluentKit} models, repositories and services`,
    entities: 'one entity and one Fluent model per table',
    table: 'entity, model, repositories and service of each table',
  },
}
