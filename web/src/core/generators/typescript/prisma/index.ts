/**
 * TypeScript + Prisma 7 (Strategy of common/orm.ts): a Prisma schema that reflects the database, the client
 * through the driver adapter of the chosen database, plain entities the repositories turn rows into, a unit of
 * work whose transaction is the client's, and tests on a database created from the schema by Prisma itself
 * (SQLite in memory, or the database TEST_DATABASE_URL names: a Prisma schema is for one kind of database).
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { quote, TsImports } from '../typescript.ts'
import { plainEntityFile } from '../common/entities.ts'
import { repositoryInterface, sqlRepositoryClass, writesEntities, type Context } from '../common/context.ts'
import type { TsOrm } from '../common/orm.ts'
import { clientModule, prismaBody, prismaHelpers } from './repository.ts'
import { providerOf, schemaFile } from './schema.ts'

const VERSION = '^7.10.1'

const ADAPTERS = {
  postgresql: { package: '@prisma/adapter-pg', name: 'PrismaPg', label: 'PostgreSQL' },
  mysql: { package: '@prisma/adapter-mariadb', name: 'PrismaMariaDb', label: 'MySQL or MariaDB' },
  sqlite: { package: '@prisma/adapter-better-sqlite3', name: 'PrismaBetterSqlite3', label: 'SQLite' },
}

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mysql://app:app@localhost:3306/app',
  sqlite: 'file:./app.db',
}

const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql

const adapterOf = (context: Context) => ADAPTERS[providerOf(context)]

/** `src/database.ts`: the client of the database DATABASE_URL names, through the driver adapter. */
function databaseFile(context: Context): GeneratedFile {
  const adapter = adapterOf(context)
  const provider = providerOf(context)
  const imports = new TsImports('src/database').from(adapter.package, adapter.name).from(clientModule(context), 'PrismaClient')
  const create: Line[] =
    provider === 'postgresql'
      ? [`  return new PrismaClient({ adapter: new ${adapter.name}({ connectionString: url }) })`]
      : provider === 'mysql'
        ? [
            '  // The MariaDB driver reads mysql:// addresses as mariadb://, and MySQL 8 checks passwords with the server key',
            "  const address = new URL(url.replace(/^mysql:/, 'mariadb:'))",
            "  if (!address.searchParams.has('allowPublicKeyRetrieval')) address.searchParams.set('allowPublicKeyRetrieval', 'true')",
            `  return new PrismaClient({ adapter: new ${adapter.name}(address.toString()) })`,
          ]
        : [`  return new PrismaClient({ adapter: new ${adapter.name}({ url }) })`]
  return {
    path: 'src/database.ts',
    content: lines(
      `/** The Prisma client of the ${adapter.label} database DATABASE_URL names (see .env.example). */`,
      imports.write(),
      '',
      `export const DATABASE_URL = process.env.DATABASE_URL ?? ${quote(defaultUrl(context))}`,
      '',
      provider === 'sqlite'
        ? '/** A client for the SQLite database at `url` (file:<path>, or file::memory: for one in memory). Close it with $disconnect(). */'
        : `/** A client for the ${adapter.label} database at \`url\`. Close it with $disconnect(). */`,
      'export function createClient(url: string = DATABASE_URL): PrismaClient {',
      ...create,
      '}',
      '',
    ),
  }
}

function configFile(context: Context): GeneratedFile {
  return {
    path: 'prisma.config.ts',
    content: lines(
      '/** Where the Prisma CLI finds the schema and the database (DATABASE_URL). */',
      "import { defineConfig } from 'prisma/config'",
      '',
      'export default defineConfig({',
      "  schema: 'prisma/schema.prisma',",
      `  datasource: { url: process.env.DATABASE_URL ?? ${quote(defaultUrl(context))} },`,
      '})',
      '',
    ),
  }
}

function databaseFiles(context: Context): GeneratedFile[] {
  const files = [databaseFile(context)]
  if (writesEntities(context)) files.push(schemaFile(context), configFile(context))
  const where = writesEntities(context)
    ? 'Its table is a model of prisma/schema.prisma.'
    : 'Its table is a model of the Prisma schema the client comes from.'
  for (const info of context.tables) files.push(plainEntityFile(context, info, where))
  return files
}

function unitOfWork(context: Context, imports: TsImports): Line[] {
  imports.type(clientModule(context), 'Prisma')
  const interfaces = context.settings.repositoryInterfaces
  const operation = context.settings.transactions === 'operation'
  if (operation) imports.type(clientModule(context), 'PrismaClient')
  return [
    "/** The repositories over one Prisma client: the application's, or the one of a transaction. */",
    'export class SqlUnitOfWork implements UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${interfaces ? repositoryInterface(info) : sqlRepositoryClass(info)}`),
    '',
    operation
      ? ['  constructor(', '    readonly db: Prisma.TransactionClient,', '    private readonly inTransaction = false,', '  ) {']
      : '  constructor(readonly db: Prisma.TransactionClient) {',
    ...context.tables.map((info) => `    this.${info.attr} = new ${sqlRepositoryClass(info)}(db)`),
    '  }',
    '',
    operation
      ? [
          '  /** Runs `work` in a transaction of its own, or in the one already open. */',
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    if (this.inTransaction) return work(this)',
          '    return (this.db as PrismaClient).$transaction((db) => work(new SqlUnitOfWork(db, true)))',
          '  }',
        ]
      : [
          `  /** ${context.settings.transactions === 'caller' ? 'The transaction belongs to whoever created the client (`$transaction`)' : 'Every write is committed at once'}: this only groups the code. */`,
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    return work(this)',
          '  }',
        ],
    '}',
  ].flat()
}

/** How each kind of database is emptied before a test: its tables are dropped. */
const EMPTY: Record<string, string[]> = {
  postgresql: [
    "  await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE')",
    "  await client.$executeRawUnsafe('CREATE SCHEMA public')",
  ],
  mysql: [
    '  const tables = await client.$queryRawUnsafe<{ name: string }[]>(',
    "    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',",
    '  )',
    '  // In a transaction, so every statement runs on the connection whose foreign key checks are off',
    '  await client.$transaction(async (db) => {',
    "    await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')",
    '    for (const { name } of tables) await db.$executeRawUnsafe(`DROP TABLE \\`${name}\\``)',
    "    await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')",
    '  })',
  ],
  sqlite: [
    "  await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')",
    '  const tables = await client.$queryRawUnsafe<{ name: string }[]>(',
    `    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",`,
    '  )',
    '  for (const { name } of tables) await client.$executeRawUnsafe(`DROP TABLE "${name}"`)',
    "  await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')",
  ],
}

/** The test that proves which database ran: its name, or SQLite itself. */
const WHICH: Record<string, string[]> = {
  postgresql: [
    "    const [row] = await sqlUow().db.$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name')",
    '    expect(row.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  mysql: [
    "    const [row] = await sqlUow().db.$queryRawUnsafe<{ name: string }[]>('SELECT DATABASE() AS name')",
    '    expect(row.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
  ],
  sqlite: [
    "    const [row] = await sqlUow().db.$queryRawUnsafe<{ version: string }[]>('SELECT sqlite_version() AS version')",
    '    expect(row.version).toMatch(/^3\\./)',
  ],
}

function testDatabase(context: Context): GeneratedFile[] {
  const provider = providerOf(context)
  const adapter = adapterOf(context)
  return [
    {
      path: 'test/setup.ts',
      content: lines(
        '/** Before the tests: the SQL that creates the tables of prisma/schema.prisma, from Prisma itself, for test/database.ts. */',
        "import { execSync } from 'node:child_process'",
        "import type { TestProject } from 'vitest/node'",
        '',
        "declare module 'vitest' {",
        '  export interface ProvidedContext {',
        '    schemaSql: string[]',
        '  }',
        '}',
        '',
        'export default function setup(project: TestProject): void {',
        "  const script = execSync('npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script', {",
        "    encoding: 'utf8',",
        "    stdio: ['ignore', 'pipe', 'inherit'],",
        "    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },",
        '  })',
        '  // One statement at a time: the drivers run one per call',
        '  const statements = script',
        '    .split(/;\\s*$/m)',
        "    .map((statement) => statement.replace(/^--.*$/gm, '').trim())",
        '    .filter((statement) => statement.length > 0)',
        "  project.provide('schemaSql', statements)",
        '}',
        '',
      ),
    },
    {
      path: 'test/database.ts',
      content: lines(
        provider === 'sqlite'
          ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from prisma/schema.prisma for every test. */'
          : `/** The test database: the ${adapter.label} database TEST_DATABASE_URL names, created empty from prisma/schema.prisma for every test. */`,
        "import { afterEach, beforeEach, inject } from 'vitest'",
        "import { createClient } from '../src/database.js'",
        `import type { PrismaClient } from '${clientModule(context).startsWith('src/') ? `../${clientModule(context)}.js` : clientModule(context)}'`,
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        '',
        provider === 'sqlite'
          ? "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'file::memory:'"
          : [
              "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
              '// The schema is for one kind of database: the tests cannot fall back to SQLite',
              "if (TEST_DATABASE_URL === '')",
              `  throw new Error('The database tests need a disposable ${adapter.label} database: set TEST_DATABASE_URL (it is emptied)')`,
            ],
        '',
        '/** Drops every table of the test database. */',
        'async function empty(client: PrismaClient): Promise<void> {',
        ...EMPTY[provider],
        '}',
        '',
        '/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */',
        'export function useTestDatabase(): () => SqlUnitOfWork {',
        '  let client: PrismaClient | undefined',
        '  beforeEach(async () => {',
        '    client = createClient(TEST_DATABASE_URL)',
        '    await empty(client)',
        "    for (const statement of inject('schemaSql')) await client.$executeRawUnsafe(statement)",
        '  })',
        '  afterEach(async () => {',
        '    await client?.$disconnect()',
        '  })',
        '  return () => new SqlUnitOfWork(client!)',
        '}',
        '',
      ),
    },
    {
      path: 'test/database.test.ts',
      content: lines(
        '/** The tests run on the database they were asked to. */',
        "import { describe, expect, it } from 'vitest'",
        provider === 'sqlite'
          ? "import { useTestDatabase } from './database.js'"
          : "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        '',
        'const sqlUow = useTestDatabase()',
        '',
        "describe('the test database', () => {",
        provider === 'sqlite' ? "  it('is SQLite', async () => {" : "  it('is the one TEST_DATABASE_URL names', async () => {",
        ...WHICH[provider],
        '  })',
        '})',
        '',
      ),
    },
  ]
}

function dependencies(context: Context): Record<string, string> {
  return { '@prisma/client': VERSION, [adapterOf(context).package]: VERSION }
}

export const prismaOrm: TsOrm = {
  id: 'prisma',
  label: 'Prisma 7',
  plainEntities: true,
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through a Prisma client.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to the client it was given.'}`,
    helpers: prismaHelpers,
    init: (context, imports) => {
      imports.type(clientModule(context), 'Prisma')
      return ['constructor(private readonly db: Prisma.TransactionClient) {}']
    },
    body: prismaBody,
  },
  unitOfWork,
  unset: (target) => `${target} === undefined`,
  testDatabase,
  memoryTests: (context) => providerOf(context) === 'sqlite',
  testSetup: (context) => (context.settings.tests !== 'none' && writesEntities(context) ? 'test/setup.ts' : null),
  // The client is generated from the schema when the dependencies are installed
  scripts: (context): Record<string, string> => (writesEntities(context) ? { postinstall: 'prisma generate' } : {}),
  ignored: (context) => (writesEntities(context) ? ['src/generated/'] : []),
  dependencies,
  devDependencies: (context): Record<string, string> => (writesEntities(context) ? { prisma: VERSION } : {}),
  defaultUrl,
  layout: (context) =>
    [
      writesEntities(context) && 'prisma/schema.prisma   a model per table, as the database has it; the client is generated from it',
      writesEntities(context) && 'prisma.config.ts       where the Prisma CLI finds the schema and DATABASE_URL',
      'src/database.ts        the Prisma client: DATABASE_URL, through the driver adapter',
    ].filter((line): line is string => typeof line === 'string'),
}
