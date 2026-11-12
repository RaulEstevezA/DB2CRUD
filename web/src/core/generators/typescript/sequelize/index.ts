/**
 * TypeScript + Sequelize 6 (Strategy of common/orm.ts): models that reflect the database (src/models.ts), the
 * database through the driver of each kind (pg, mysql2, sqlite3), plain entities the repositories fill from the
 * models' instances, a unit of work whose transaction is Sequelize's, passed to every query, and tests on a database
 * Sequelize creates from the models (SQLite in memory, or the database TEST_DATABASE_URL names: the models are
 * written for one kind of database).
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { quote, type TsImports } from '../typescript.ts'
import { plainEntityFile } from '../common/entities.ts'
import { repositoryInterface, sqlRepositoryClass, writesEntities, type Context } from '../common/context.ts'
import type { TsOrm } from '../common/orm.ts'
import { dialectOf, modelsFile, modelsModule, type Dialect } from './models.ts'
import { sequelizeBody, sequelizeHelpers } from './repository.ts'

const VERSIONS = {
  sequelize: '^6.37.8',
  pg: '^8.16.3',
  pgHstore: '^2.3.4',
  mysql2: '^3.15.3',
  sqlite3: '^5.1.7',
}

const LABELS: Record<Dialect, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL or MariaDB', sqlite: 'SQLite' }

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mysql://app:app@localhost:3306/app',
  sqlite: 'sqlite:./app.db',
}

const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql

const CREATE: Record<Dialect, string[]> = {
  postgresql: ["  const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false, timezone: '+00:00' })"],
  mysql: [
    '  // MariaDB addresses work as mysql:// ones; whole numbers come back as numbers, and dates in UTC',
    "  const sequelize = new Sequelize(url.replace(/^mariadb:/, 'mysql:'), {",
    "    dialect: 'mysql',",
    '    logging: false,',
    "    timezone: '+00:00',",
    '    dialectOptions: { supportBigNumbers: true, bigNumberStrings: false },',
    '  })',
  ],
  sqlite: [
    "  const file = url.replace(/^sqlite:(\\/\\/)?/, '')",
    "  const sequelize = new Sequelize({ dialect: 'sqlite', storage: file === '' ? ':memory:' : file, logging: false })",
  ],
}

/** `src/database.ts`: the Sequelize instance of the database DATABASE_URL names, and its models. */
function databaseFile(context: Context): GeneratedFile {
  const dialect = dialectOf(context)
  const module = modelsModule(context)
  const target = module.startsWith('src/') ? `./${module.slice('src/'.length)}.js` : module
  return {
    path: 'src/database.ts',
    content: lines(
      `/** The ${LABELS[dialect]} database DATABASE_URL names (see .env.example), through Sequelize. */`,
      "import { Sequelize } from 'sequelize'",
      `import { defineModels, type Models } from '${target}'`,
      '',
      `export const DATABASE_URL = process.env.DATABASE_URL ?? ${quote(defaultUrl(context))}`,
      '',
      '/** The database: its Sequelize instance (close it with `db.sequelize.close()`) and the model of every table. */',
      'export interface Db {',
      '  sequelize: Sequelize',
      '  models: Models',
      '}',
      '',
      dialect === 'sqlite'
        ? '/** The SQLite database at `url` (sqlite:<path>, or sqlite::memory: for one in memory). */'
        : `/** The ${LABELS[dialect]} database at \`url\`. */`,
      'export function createDatabase(url: string = DATABASE_URL): Db {',
      ...CREATE[dialect],
      '  return { sequelize, models: defineModels(sequelize) }',
      '}',
      '',
    ),
  }
}

function databaseFiles(context: Context): GeneratedFile[] {
  const files = [databaseFile(context)]
  if (writesEntities(context)) files.push(modelsFile(context))
  const where = writesEntities(context)
    ? 'Its table is a model of src/models.ts.'
    : 'Its table is a model of the Sequelize models the project imports.'
  for (const info of context.tables) files.push(plainEntityFile(context, info, where))
  return files
}

function unitOfWork(context: Context, imports: TsImports): Line[] {
  imports.type('src/database', 'Db').type('sequelize', 'Transaction')
  const interfaces = context.settings.repositoryInterfaces
  const mode = context.settings.transactions
  return [
    '/** The repositories over one database and, when there is one, the transaction every query runs in. */',
    'export class SqlUnitOfWork implements UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${interfaces ? repositoryInterface(info) : sqlRepositoryClass(info)}`),
    '',
    '  constructor(',
    '    readonly db: Db,',
    `    readonly current: Transaction | null = null,`,
    '  ) {',
    ...context.tables.map((info) => `    this.${info.attr} = new ${sqlRepositoryClass(info)}(db, current)`),
    '  }',
    '',
    mode === 'operation'
      ? [
          '  /** Runs `work` in a transaction of its own, or in the one already open. */',
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    if (this.current) return work(this)',
          '    return this.db.sequelize.transaction((transaction) => work(new SqlUnitOfWork(this.db, transaction)))',
          '  }',
        ]
      : [
          `  /** ${mode === 'caller' ? 'The transaction belongs to whoever gave it (`current`)' : 'Every write is committed at once'}: this only groups the code. */`,
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    return work(this)',
          '  }',
        ],
    '}',
  ].flat()
}

/** How each kind of database is emptied before a test: its tables are dropped. */
const EMPTY: Record<Dialect, string[]> = {
  postgresql: ["  await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE')", "  await db.sequelize.query('CREATE SCHEMA public')"],
  mysql: [
    '  // In a transaction, so every statement runs on the connection whose foreign key checks are off',
    '  await db.sequelize.transaction(async (transaction) => {',
    '    const [tables] = (await db.sequelize.query(',
    "      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',",
    '      { transaction },',
    '    )) as [{ name: string }[], unknown]',
    "    await db.sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction })",
    '    for (const { name } of tables) await db.sequelize.query(`DROP TABLE \\`${name}\\``, { transaction })',
    "    await db.sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction })",
    '  })',
  ],
  sqlite: [
    "  await db.sequelize.query('PRAGMA foreign_keys = OFF')",
    '  const [tables] = (await db.sequelize.query(',
    `    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",`,
    '  )) as [{ name: string }[], unknown]',
    '  for (const { name } of tables) await db.sequelize.query(`DROP TABLE "${name}"`)',
    "  await db.sequelize.query('PRAGMA foreign_keys = ON')",
  ],
}

/** The test that proves which database ran: its name, or SQLite itself. */
const WHICH: Record<Dialect, string[]> = {
  postgresql: [
    "    const [rows] = (await sqlUow().db.sequelize.query('SELECT current_database() AS name')) as [{ name: string }[], unknown]",
    '    expect(rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  mysql: [
    "    const [rows] = (await sqlUow().db.sequelize.query('SELECT DATABASE() AS name')) as [{ name: string }[], unknown]",
    '    expect(rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  sqlite: [
    "    const [rows] = (await sqlUow().db.sequelize.query('SELECT sqlite_version() AS version')) as [{ version: string }[], unknown]",
    '    expect(rows[0].version).toMatch(/^3\\./)',
  ],
}

function testDatabase(context: Context): GeneratedFile[] {
  const dialect = dialectOf(context)
  const sqlite = dialect === 'sqlite'
  return [
    {
      path: 'test/database.ts',
      content: lines(
        sqlite
          ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from the models for every test. */'
          : `/** The test database: the ${LABELS[dialect]} database TEST_DATABASE_URL names, created empty from the models for every test. */`,
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Db } from '../src/database.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        '',
        sqlite
          ? "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'sqlite::memory:'"
          : [
              "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
              '// The models are written for one kind of database: the tests cannot fall back to SQLite',
              "if (TEST_DATABASE_URL === '')",
              `  throw new Error('The database tests need a disposable ${LABELS[dialect]} database: set TEST_DATABASE_URL (it is emptied)')`,
            ],
        '',
        '/** Drops every table of the test database. */',
        'async function empty(db: Db): Promise<void> {',
        ...EMPTY[dialect],
        '}',
        '',
        '/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */',
        'export function useTestDatabase(): () => SqlUnitOfWork {',
        '  let db: Db | undefined',
        '  beforeEach(async () => {',
        '    db = createDatabase(TEST_DATABASE_URL)',
        '    await empty(db)',
        '    // Creates every table from the models',
        '    await db.sequelize.sync()',
        '  })',
        '  afterEach(async () => {',
        '    await db?.sequelize.close()',
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

function dependencies(context: Context): Record<string, string> {
  const driver: Record<Dialect, Record<string, string>> = {
    postgresql: { pg: VERSIONS.pg, 'pg-hstore': VERSIONS.pgHstore },
    mysql: { mysql2: VERSIONS.mysql2 },
    sqlite: { sqlite3: VERSIONS.sqlite3 },
  }
  return { sequelize: VERSIONS.sequelize, ...driver[dialectOf(context)] }
}

export const sequelizeOrm: TsOrm = {
  id: 'sequelize',
  label: 'Sequelize 6',
  plainEntities: true,
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through Sequelize.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: queries run in the transaction it was given.'}`,
    helpers: sequelizeHelpers,
    init: (_context, imports) => {
      imports.type('src/database', 'Db').type('sequelize', 'Transaction')
      return ['constructor(', '  private readonly db: Db,', '  private readonly transaction: Transaction | null = null,', ') {}']
    },
    body: sequelizeBody,
  },
  unitOfWork,
  unset: (target) => `${target} === undefined`,
  testDatabase,
  memoryTests: (context) => dialectOf(context) === 'sqlite',
  dependencies,
  devDependencies: () => ({}),
  defaultUrl,
  layout: (context) =>
    [
      writesEntities(context) && 'src/models.ts          the Sequelize models, as the database has them',
      'src/database.ts        the database: DATABASE_URL, its Sequelize instance and models',
    ].filter((line): line is string => typeof line === 'string'),
}
