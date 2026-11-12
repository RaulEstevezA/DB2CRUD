/**
 * TypeScript + Drizzle 0.45 (Strategy of common/orm.ts): tables that reflect the database (src/schema.ts), the
 * database through the driver of each kind (node-postgres, mysql2, better-sqlite3), plain entities the
 * repositories fill from Drizzle's rows, a unit of work whose transaction is the database's, and tests on a
 * database created from the tables with the SQL drizzle-kit writes (SQLite in memory, or the database
 * TEST_DATABASE_URL names: the tables are written for one kind of database).
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { quote, TsImports } from '../typescript.ts'
import { plainEntityFile } from '../common/entities.ts'
import { repositoryInterface, sqlRepositoryClass, writesEntities, type Context } from '../common/context.ts'
import type { TsOrm } from '../common/orm.ts'
import { drizzleBody, drizzleHelpers } from './repository.ts'
import { columnTypesFile, dialectOf, schemaFile, type Dialect } from './schema.ts'

const VERSIONS = {
  drizzleOrm: '^0.45.4',
  drizzleKit: '^0.31.11',
  pg: '^8.16.3',
  typesPg: '^8.15.5',
  mysql2: '^3.15.3',
  betterSqlite3: '^12.4.1',
  typesBetterSqlite3: '^7.6.13',
}

const LABELS: Record<Dialect, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL or MariaDB', sqlite: 'SQLite' }

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mysql://app:app@localhost:3306/app',
  sqlite: 'file:./app.db',
}

const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql

/** The lines of src/database.ts that change with the database: its driver, its types and how it says no. */
const DRIVERS: Record<Dialect, { imports: string[]; types: Line[]; create: Line[]; refusal: string }> = {
  postgresql: {
    imports: ["import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'", "import pg from 'pg'"],
    types: [
      '/** The database: queries through a pool of connections (close it with `db.$client.end()`). */',
      'export type Db = NodePgDatabase & { $client: pg.Pool }',
      '',
      '/** The database or one of its transactions: what the repositories run their queries on. */',
      "export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]",
    ],
    create: ['  return drizzle(new pg.Pool({ connectionString: url }))'],
    // SQLSTATE class 23: integrity constraint violation
    refusal: "  return typeof code === 'string' && code.startsWith('23')",
  },
  mysql: {
    imports: ["import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'", "import mysql from 'mysql2/promise'"],
    types: [
      '/** The database: queries through a pool of connections (close it with `db.$client.end()`). */',
      'export type Db = MySql2Database & { $client: mysql.Pool }',
      '',
      '/** The database or one of its transactions: what the repositories run their queries on. */',
      "export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]",
    ],
    create: [
      '  // MariaDB addresses work as mysql:// ones; whole numbers come back as numbers, and dates in UTC',
      "  const uri = url.replace(/^mariadb:/, 'mysql:')",
      "  return drizzle(mysql.createPool({ uri, supportBigNumbers: true, bigNumberStrings: false, timezone: 'Z' }))",
    ],
    refusal: "  return typeof sqlState === 'string' && sqlState.startsWith('23')",
  },
  sqlite: {
    imports: ["import Database from 'better-sqlite3'", "import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'"],
    types: [
      '/** The database: one connection (close it with `db.$client.close()`). */',
      'export type Db = BetterSQLite3Database & { $client: Database.Database }',
      '',
      '/** What the repositories run their queries on: SQLite has one connection, so transactions run on it too. */',
      'export type Executor = Db',
    ],
    create: [
      "  const file = url.replace(/^file:/, '')",
      "  const client = new Database(file === '' || file === ':memory:' ? ':memory:' : file)",
      '  // SQLite checks foreign keys only when asked to',
      "  client.pragma('foreign_keys = ON')",
      '  return drizzle(client)',
    ],
    refusal: "  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')",
  },
}

/** `src/database.ts`: the database DATABASE_URL names, the types the repositories run on, and its refusals. */
function databaseFile(context: Context): GeneratedFile {
  const dialect = dialectOf(context)
  const driver = DRIVERS[dialect]
  const field = dialect === 'mysql' ? 'sqlState' : 'code'
  return {
    path: 'src/database.ts',
    content: lines(
      `/** The ${LABELS[dialect]} database DATABASE_URL names (see .env.example), through Drizzle. */`,
      "import { DrizzleQueryError } from 'drizzle-orm'",
      ...driver.imports,
      '',
      `export const DATABASE_URL = process.env.DATABASE_URL ?? ${quote(defaultUrl(context))}`,
      '',
      ...driver.types,
      '',
      dialect === 'sqlite'
        ? '/** The SQLite database at `url` (file:<path>, or file::memory: for one in memory). */'
        : `/** The ${LABELS[dialect]} database at \`url\`. */`,
      'export function createDatabase(url: string = DATABASE_URL): Db {',
      ...driver.create,
      '}',
      '',
      '/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
      'export function isRefusal(error: unknown): boolean {',
      '  const cause = error instanceof DrizzleQueryError ? error.cause : error',
      `  const ${field} = (cause as { ${field}?: unknown } | undefined)?.${field}`,
      driver.refusal,
      '}',
      '',
    ),
  }
}

function configFile(context: Context): GeneratedFile {
  return {
    path: 'drizzle.config.ts',
    content: lines(
      '/** Where drizzle-kit finds the tables and the database (DATABASE_URL), for `drizzle-kit studio` or `pull`. Never push or migrate: the database already exists. */',
      "import { defineConfig } from 'drizzle-kit'",
      '',
      'export default defineConfig({',
      `  dialect: '${dialectOf(context)}',`,
      "  schema: './src/schema.ts',",
      `  dbCredentials: { url: process.env.DATABASE_URL ?? ${quote(defaultUrl(context))} },`,
      '})',
      '',
    ),
  }
}

function databaseFiles(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [databaseFile(context)]
  if (writesEntities(context)) files.push(schemaFile(context), columnTypesFile(context), configFile(context))
  const where = writesEntities(context) ? 'Its table is in src/schema.ts.' : 'Its table comes from the Drizzle tables the project imports.'
  for (const info of context.tables) files.push(plainEntityFile(context, info, where))
  return files.filter((file): file is GeneratedFile => file !== null)
}

function unitOfWork(context: Context, imports: TsImports): Line[] {
  const sqlite = dialectOf(context) === 'sqlite'
  imports.type('src/database', sqlite ? 'Db' : 'Executor')
  const interfaces = context.settings.repositoryInterfaces
  const operation = context.settings.transactions === 'operation'
  const executor = sqlite ? 'Db' : 'Executor'
  if (operation && sqlite) imports.from('drizzle-orm', 'sql')
  if (operation && !sqlite) imports.type('src/database', 'Db')
  return [
    "/** The repositories over one database: the application's, or one of its transactions. */",
    'export class SqlUnitOfWork implements UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${interfaces ? repositoryInterface(info) : sqlRepositoryClass(info)}`),
    '',
    operation
      ? ['  constructor(', `    readonly db: ${executor},`, '    private readonly inTransaction = false,', '  ) {']
      : `  constructor(readonly db: ${executor}) {`,
    ...context.tables.map((info) => `    this.${info.attr} = new ${sqlRepositoryClass(info)}(db)`),
    '  }',
    '',
    operation
      ? sqlite
        ? [
            '  /** Runs `work` in a transaction of its own, or in the one already open. */',
            '  async transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
            '    if (this.inTransaction) return work(this)',
            "    // better-sqlite3 has one connection and Drizzle's transactions on it cannot wait for promises: the",
            '    // transaction is opened and closed here',
            '    this.db.run(sql`BEGIN`)',
            '    try {',
            '      const result = await work(new SqlUnitOfWork(this.db, true))',
            '      this.db.run(sql`COMMIT`)',
            '      return result',
            '    } catch (error) {',
            '      this.db.run(sql`ROLLBACK`)',
            '      throw error',
            '    }',
            '  }',
          ]
        : [
            '  /** Runs `work` in a transaction of its own, or in the one already open. */',
            '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
            '    if (this.inTransaction) return work(this)',
            '    return (this.db as Db).transaction((db) => work(new SqlUnitOfWork(db, true)))',
            '  }',
          ]
      : [
          `  /** ${context.settings.transactions === 'caller' ? 'The transaction belongs to whoever created the database (`db.transaction`)' : 'Every write is committed at once'}: this only groups the code. */`,
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    return work(this)',
          '  }',
        ],
    '}',
  ].flat()
}

/** How each kind of database is emptied before a test: its tables are dropped. */
const EMPTY: Record<Dialect, string[]> = {
  postgresql: [
    "  await db.execute(sql.raw('DROP SCHEMA IF EXISTS public CASCADE'))",
    "  await db.execute(sql.raw('CREATE SCHEMA public'))",
  ],
  mysql: [
    '  // In a transaction, so every statement runs on the connection whose foreign key checks are off',
    '  await db.transaction(async (tx) => {',
    '    const [tables] = (await tx.execute(',
    "      sql.raw('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'),",
    '    )) as unknown as [{ name: string }[]]',
    "    await tx.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 0'))",
    '    for (const { name } of tables) await tx.execute(sql.raw(`DROP TABLE \\`${name}\\``))',
    "    await tx.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 1'))",
    '  })',
  ],
  sqlite: [
    "  db.run(sql.raw('PRAGMA foreign_keys = OFF'))",
    "  const tables = db.all<{ name: string }>(sql.raw(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\"))",
    '  for (const { name } of tables) db.run(sql.raw(`DROP TABLE "${name}"`))',
    "  db.run(sql.raw('PRAGMA foreign_keys = ON'))",
  ],
}

/** The test that proves which database ran: its name, or SQLite itself. */
const WHICH: Record<Dialect, string[]> = {
  postgresql: [
    '    const result = await sqlUow().db.execute(sql`SELECT current_database() AS name`)',
    '    expect(result.rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  mysql: [
    '    const [rows] = (await sqlUow().db.execute(sql`SELECT DATABASE() AS name`)) as unknown as [{ name: string }[]]',
    '    expect(rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  sqlite: [
    '    const row = sqlUow().db.get<{ version: string }>(sql`SELECT sqlite_version() AS version`)',
    '    expect(row.version).toMatch(/^3\\./)',
  ],
}

const KIT: Record<Dialect, [string, string]> = {
  postgresql: ['generateDrizzleJson', 'generateMigration'],
  mysql: ['generateMySQLDrizzleJson', 'generateMySQLMigration'],
  sqlite: ['generateSQLiteDrizzleJson', 'generateSQLiteMigration'],
}

function testDatabase(context: Context): GeneratedFile[] {
  const dialect = dialectOf(context)
  const sqlite = dialect === 'sqlite'
  const [json, migration] = KIT[dialect]
  const run = sqlite ? 'db.run' : 'await db.execute'
  return [
    {
      path: 'test/database.ts',
      content: lines(
        sqlite
          ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from src/schema.ts for every test. */'
          : `/** The test database: the ${LABELS[dialect]} database TEST_DATABASE_URL names, created empty from src/schema.ts for every test. */`,
        "import { sql } from 'drizzle-orm'",
        `import { ${json}, ${migration} } from 'drizzle-kit/api'`,
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Db } from '../src/database.js'",
        "import * as schema from '../src/schema.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
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
        '/** The statements that create every table of src/schema.ts, as drizzle-kit writes them. */',
        'async function schemaSql(): Promise<string[]> {',
        `  return ${migration}(await ${json}({}), await ${json}(schema))`,
        '}',
        '',
        '/** Drops every table of the test database. */',
        `${sqlite ? 'function' : 'async function'} empty(db: Db): ${sqlite ? 'void' : 'Promise<void>'} {`,
        ...EMPTY[dialect],
        '}',
        '',
        '/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */',
        'export function useTestDatabase(): () => SqlUnitOfWork {',
        '  let db: Db | undefined',
        '  let statements: string[] | undefined',
        '  beforeEach(async () => {',
        '    statements ??= await schemaSql()',
        '    db = createDatabase(TEST_DATABASE_URL)',
        `    ${sqlite ? '' : 'await '}empty(db)`,
        `    for (const statement of statements) ${run}(sql.raw(statement))`,
        '  })',
        '  afterEach(async () => {',
        sqlite ? '    db?.$client.close()' : '    await db?.$client.end()',
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
        "import { sql } from 'drizzle-orm'",
        "import { describe, expect, it } from 'vitest'",
        sqlite ? "import { useTestDatabase } from './database.js'" : "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        '',
        'const sqlUow = useTestDatabase()',
        '',
        "describe('the test database', () => {",
        sqlite ? "  it('is SQLite', () => {" : "  it('is the one TEST_DATABASE_URL names', async () => {",
        ...WHICH[dialect],
        '  })',
        '})',
        '',
      ),
    },
  ]
}

function dependencies(context: Context): Record<string, string> {
  const dialect = dialectOf(context)
  const driver: Record<Dialect, Record<string, string>> = {
    postgresql: { pg: VERSIONS.pg },
    mysql: { mysql2: VERSIONS.mysql2 },
    sqlite: { 'better-sqlite3': VERSIONS.betterSqlite3 },
  }
  return { 'drizzle-orm': VERSIONS.drizzleOrm, ...driver[dialect] }
}

function devDependencies(context: Context): Record<string, string> {
  const dialect = dialectOf(context)
  const types: Record<string, string> =
    dialect === 'postgresql'
      ? { '@types/pg': VERSIONS.typesPg }
      : dialect === 'sqlite'
        ? { '@types/better-sqlite3': VERSIONS.typesBetterSqlite3 }
        : {}
  return { ...types, ...(writesEntities(context) ? { 'drizzle-kit': VERSIONS.drizzleKit } : {}) }
}

export const drizzleOrm: TsOrm = {
  id: 'drizzle',
  label: 'Drizzle 0.45',
  plainEntities: true,
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through Drizzle.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to the database it was given.'}`,
    helpers: drizzleHelpers,
    init: (context, imports) => {
      imports.type('src/database', dialectOf(context) === 'sqlite' ? 'Db' : 'Executor')
      return [`constructor(private readonly db: ${dialectOf(context) === 'sqlite' ? 'Db' : 'Executor'}) {}`]
    },
    body: drizzleBody,
  },
  unitOfWork,
  unset: (target) => `${target} === undefined`,
  testDatabase,
  memoryTests: (context) => dialectOf(context) === 'sqlite',
  dependencies,
  devDependencies,
  defaultUrl,
  layout: (context) =>
    [
      writesEntities(context) && 'src/schema.ts          the Drizzle tables, as the database has them',
      writesEntities(context) && 'drizzle.config.ts      where drizzle-kit finds the tables and DATABASE_URL',
      'src/database.ts        the database: DATABASE_URL, through its driver',
    ].filter((line): line is string => typeof line === 'string'),
}
