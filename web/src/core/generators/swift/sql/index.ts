/**
 * Swift without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through SQLKit and the driver of
 * the database (sql/database.ts holds the pool and the helpers), plain structs as entities, a unit of work whose transaction
 * is a connection's, and tests on a real database created from the schema's DDL (SQLite in memory, or the database
 * TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors csharp/sql/index.ts.
 */
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import { usesTimes, type Context } from '../context.ts'
import type { SwiftOrm } from '../orm.ts'
import { swString } from '../swift.ts'
import { NAMES } from '../tests.ts'
import { databaseFile, driverOf, entityFile } from './database.ts'
import { sqlBody, sqlFunctions } from './repository.ts'

const VERSIONS = {
  sql: '3.36.0',
  postgres: '2.17.0',
  mysql: '4.10.2',
  sqlite: '4.5.2',
  async: '1.22.0',
  nio: '2.105.0',
  log: '1.17.2',
  postgresNio: '1.33.3',
}

const PACKAGES: Record<string, { name: string; version: string }> = {
  PostgresKit: { name: 'postgres-kit', version: VERSIONS.postgres },
  MySQLKit: { name: 'mysql-kit', version: VERSIONS.mysql },
  SQLiteKit: { name: 'sqlite-kit', version: VERSIONS.sqlite },
}

function testDatabase(context: Context) {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const missing = swString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)
  const check =
    database === 'postgresql'
      ? 'SELECT current_database()::text AS value'
      : sqlite
        ? 'SELECT sqlite_version() AS value'
        : 'SELECT DATABASE() AS value'
  const list = (name: string, doc: string, statements: string[]) => [
    '',
    `    /// ${doc}`,
    `    private static let ${name}: [String] = [`,
    ...statements.map((statement) => `        ${swString(statement)},`),
    '    ]',
  ]
  const drop = list('drop', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database))
  const create = list('create', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database))
  return {
    modules: ['SQLKit', ...(sqlite ? ['SQLiteKit'] : [])],
    open: sqlite
      ? [
          '        let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"]',
          '        let app = if let url { AppDatabase(url: url) } else { AppDatabase(configuration: SQLiteConfiguration(storage: .memory)) }',
        ]
      : [
          '        // The tables are written for one kind of database: the tests cannot fall back to SQLite',
          `        let url = try #require(ProcessInfo.processInfo.environment["TEST_DATABASE_URL"], ${missing})`,
          '        let app = try AppDatabase(url: url)',
        ],
    recreate: [
      '    /// Drops every table and creates them again; on one connection, as MySQL turns its foreign key checks off for the connection that asks.',
      '    private static func recreate(_ db: Db) async throws {',
      '        try await db.sql.withSession { session in',
      '            for statement in drop + create { try await session.raw("\\(unsafeRaw: statement)").run() }',
      '        }',
      '    }',
      ...drop,
      ...create,
    ],
    check: `uow.db.sql.raw(${swString(check)}).all()`,
  }
}

const url = (owner: string, name: string, version: string) =>
  `.package(url: "https://github.com/${owner}/${name}.git", from: "${version}"),`
const product = (name: string, pkg: string) => `.product(name: "${name}", package: "${pkg}")`

function packages(context: Context) {
  const driver = driverOf(context).module
  const pkg = PACKAGES[driver]
  // TimeOfDay says how PostgreSQL keeps it
  const times = context.settings.database === 'postgresql' && usesTimes(context)
  return {
    packages: [
      url('vapor', 'sql-kit', VERSIONS.sql),
      url('vapor', pkg.name, pkg.version),
      url('vapor', 'async-kit', VERSIONS.async),
      url('apple', 'swift-nio', VERSIONS.nio),
      url('apple', 'swift-log', VERSIONS.log),
      ...(times ? [url('vapor', 'postgres-nio', VERSIONS.postgresNio)] : []),
    ],
    products: [
      product('SQLKit', 'sql-kit'),
      product(driver, pkg.name),
      product('AsyncKit', 'async-kit'),
      product('NIOCore', 'swift-nio'),
      product('NIOPosix', 'swift-nio'),
      product('Logging', 'swift-log'),
      ...(times ? [product('PostgresNIO', 'postgres-nio')] : []),
    ],
    testProducts: [product('SQLKit', 'sql-kit'), product(driver, pkg.name)],
  }
}

export const sqlOrm: SwiftOrm = {
  id: 'sql',
  label: 'SQLKit',
  holder: { type: 'Db', optional: 'Db?', modules: [] },
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}"' : '"[]"'),
  databaseFile,
  entityFiles: (context, info) => [entityFile(context, info)],
  repository: {
    modules: () => ['SQLKit'],
    body: (context, info, method) => sqlBody(context, info, method),
    refusal: 'let error where isRefusal(error)',
    functions: sqlFunctions,
  },
  transaction: 'try await db.transaction { transaction in try await work(SqlUnitOfWork(db: transaction)) }',
  testDatabase,
  packages,
  readme: {
    intro: `plain entities, repositories with their own SQL through SQLKit ${VERSIONS.sql} and services`,
    entities: 'one entity per table',
    table: 'entity, repositories and service of each table',
  },
}
