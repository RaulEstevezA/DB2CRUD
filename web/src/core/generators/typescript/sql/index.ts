/**
 * TypeScript without an ORM (Strategy of common/orm.ts): repositories that write their SQL, through each
 * database's driver (node-postgres, mysql2, better-sqlite3) behind one small interface (sql/database.ts); plain
 * classes as entities; a unit of work whose transaction is the database's; and tests on a real database created
 * from the schema's DDL (SQLite in memory, or the database TEST_DATABASE_URL names: the DDL is written for one
 * kind of database). Mirrors python/sql/index.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import { lines, type Line } from '../../types.ts'
import { quote, type TsImports } from '../typescript.ts'
import { repositoryInterface, sqlRepositoryClass, type Context } from '../common/context.ts'
import type { TsOrm } from '../common/orm.ts'
import { databaseFiles, defaultUrl, dialectOf, DRIVER_LABELS, LABELS, type Dialect } from './database.ts'
import { sqlBody, sqlHelpers } from './repository.ts'

const VERSIONS = {
  pg: '^8.16.3',
  typesPg: '^8.15.5',
  mysql2: '^3.15.3',
  betterSqlite3: '^12.4.1',
  typesBetterSqlite3: '^7.6.13',
}

function unitOfWork(context: Context, imports: TsImports): Line[] {
  imports.type('src/database', 'Db')
  const interfaces = context.settings.repositoryInterfaces
  const transactions = context.settings.transactions
  return [
    "/** The repositories over one database: the application's, or one of its transactions. */",
    'export class SqlUnitOfWork implements UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${interfaces ? repositoryInterface(info) : sqlRepositoryClass(info)}`),
    '',
    '  constructor(readonly db: Db) {',
    ...context.tables.map((info) => `    this.${info.attr} = new ${sqlRepositoryClass(info)}(db)`),
    '  }',
    '',
    transactions === 'operation'
      ? [
          '  /** Runs `work` in a transaction of its own, or in the one already open. */',
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    return this.db.transaction((db) => work(new SqlUnitOfWork(db)))',
          '  }',
        ]
      : [
          `  /** ${transactions === 'caller' ? 'The transaction belongs to whoever created the unit of work (`db.transaction`)' : 'Every write is committed at once'}: this only groups the code. */`,
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    return work(this)',
          '  }',
        ],
    '}',
  ].flat()
}

/** test/schema.ts: the SQL that removes and creates the tables of the test database. */
function schemaFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const list = (name: string, doc: string, statements: string[]) => [
    `/** ${doc} */`,
    `export const ${name}: string[] = [`,
    ...statements.map((statement) => `  ${quote(statement).replace(/\n/g, '\\n')},`),
    ']',
  ]
  return {
    path: 'test/schema.ts',
    content: lines(
      '/** The tables of the test database, as the schema DB2CRUD read has them. */',
      '',
      ...list('DROP', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database)),
      '',
      ...list('CREATE', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database)),
      '',
    ),
  }
}

/** The test that proves which database ran: its name, or SQLite itself. */
const WHICH: Record<Dialect, string[]> = {
  postgresql: [
    "    const row = await sqlUow().db.one('SELECT current_database() AS name')",
    '    expect(row?.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  mysql: [
    "    const row = await sqlUow().db.one('SELECT DATABASE() AS name')",
    '    expect(row?.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  sqlite: ["    const row = await sqlUow().db.one('SELECT sqlite_version() AS version')", '    expect(row?.version).toMatch(/^3\\./)'],
}

function testDatabase(context: Context): GeneratedFile[] {
  const dialect = dialectOf(context)
  const sqlite = dialect === 'sqlite'
  return [
    schemaFile(context),
    {
      path: 'test/database.ts',
      content: lines(
        sqlite
          ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from test/schema.ts for every test. */'
          : `/** The test database: the ${LABELS[dialect]} database TEST_DATABASE_URL names, created empty from test/schema.ts for every test. */`,
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Database } from '../src/database.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        "import { CREATE, DROP } from './schema.js'",
        '',
        sqlite
          ? "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'file::memory:'"
          : [
              "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
              '// The tables are written for one kind of database: the tests cannot fall back to SQLite',
              "if (TEST_DATABASE_URL === '')",
              `  throw new Error('The database tests need a disposable ${LABELS[dialect]} database: set TEST_DATABASE_URL (it is emptied)')`,
            ],
        '',
        '/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */',
        'export function useTestDatabase(): () => SqlUnitOfWork {',
        '  let db: Database | undefined',
        '  beforeEach(async () => {',
        '    db = createDatabase(TEST_DATABASE_URL)',
        '    // On one connection: MySQL turns its foreign key checks off for the connection that asks',
        '    await db.transaction(async (connection) => {',
        '      for (const statement of [...DROP, ...CREATE]) await connection.run(statement)',
        '    })',
        '  })',
        '  afterEach(async () => {',
        '    await db?.close()',
        '  })',
        '  return () => new SqlUnitOfWork(db!)',
        '}',
        '',
      ),
    },
    {
      path: 'test/database.test.ts',
      content: lines(
        '/** The tests run on the database they were asked to. */',
        "import { describe, expect, it } from 'vitest'",
        sqlite ? "import { useTestDatabase } from './database.js'" : "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        '',
        'const sqlUow = useTestDatabase()',
        '',
        "describe('the test database', () => {",
        sqlite ? "  it('is SQLite', async () => {" : "  it('is the one TEST_DATABASE_URL names', async () => {",
        ...WHICH[dialect],
        '  })',
        '})',
        '',
      ),
    },
  ]
}

const DEPENDENCIES: Record<Dialect, Record<string, string>> = {
  postgresql: { pg: VERSIONS.pg },
  mysql: { mysql2: VERSIONS.mysql2 },
  sqlite: { 'better-sqlite3': VERSIONS.betterSqlite3 },
}

const DEV_DEPENDENCIES: Record<Dialect, Record<string, string>> = {
  postgresql: { '@types/pg': VERSIONS.typesPg },
  mysql: {},
  sqlite: { '@types/better-sqlite3': VERSIONS.typesBetterSqlite3 },
}

export const sqlOrm: TsOrm = {
  id: 'sql',
  label: 'SQL',
  plainEntities: false,
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, with SQL through ${DRIVER_LABELS[dialectOf(context)]}.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to the database it was given.'}`,
    helpers: sqlHelpers,
    init: (_context, imports) => {
      imports.type('src/database', 'Db')
      return ['constructor(private readonly db: Db) {}']
    },
    body: sqlBody,
  },
  unitOfWork,
  unset: (target) => `${target} === undefined`,
  testDatabase,
  memoryTests: (context) => dialectOf(context) === 'sqlite',
  dependencies: (context) => DEPENDENCIES[dialectOf(context)],
  devDependencies: (context) => DEV_DEPENDENCIES[dialectOf(context)],
  defaultUrl,
  layout: () => ['src/database.ts        the database: DATABASE_URL, through its driver, and the calls that run SQL'],
}
