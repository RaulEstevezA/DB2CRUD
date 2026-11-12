/**
 * TypeScript + TypeORM 0.3 (Strategy of common/orm.ts): the data source and entities faithful to the
 * database, repositories over an EntityManager, a unit of work whose transaction is the manager's, and tests on
 * a real database created from the entities (SQLite in memory unless TEST_DATABASE_URL names another).
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Line } from '../../types.ts'
import { repositoryInterface, sqlRepositoryClass, writesEntities, type Context } from '../common/context.ts'
import type { TsOrm } from '../common/orm.ts'
import type { TsImports } from '../typescript.ts'
import { databaseFiles, defaultUrl } from './database.ts'
import { typeormBody } from './repository.ts'

const VERSIONS = {
  typeorm: '^0.3.27',
  reflectMetadata: '^0.2.2',
  pg: '^8.16.3',
  mysql2: '^3.15.3',
  betterSqlite3: '^12.4.1',
}

function dependencies(context: Context): Record<string, string> {
  const deps: Record<string, string> = { typeorm: VERSIONS.typeorm, 'reflect-metadata': VERSIONS.reflectMetadata }
  const database = context.settings.database
  if (database === 'postgresql') deps.pg = VERSIONS.pg
  if (database === 'mysql' || database === 'mariadb') deps.mysql2 = VERSIONS.mysql2
  if (database === 'sqlite') deps['better-sqlite3'] = VERSIONS.betterSqlite3
  return deps
}

function devDependencies(context: Context): Record<string, string> {
  // The tests run on SQLite in memory unless TEST_DATABASE_URL names another database
  return context.settings.database === 'sqlite' || context.settings.tests === 'none' ? {} : { 'better-sqlite3': VERSIONS.betterSqlite3 }
}

function unitOfWork(context: Context, imports: TsImports): Line[] {
  imports.type('typeorm', 'EntityManager')
  const interfaces = context.settings.repositoryInterfaces
  const operation = context.settings.transactions === 'operation'
  return [
    "/** The repositories over one EntityManager: the data source's, or the one of a transaction. */",
    'export class SqlUnitOfWork implements UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${interfaces ? repositoryInterface(info) : sqlRepositoryClass(info)}`),
    '',
    '  constructor(readonly manager: EntityManager) {',
    ...context.tables.map((info) => `    this.${info.attr} = new ${sqlRepositoryClass(info)}(manager)`),
    '  }',
    '',
    operation
      ? [
          '  /** Runs `work` in a transaction of its own, or in the one already open. */',
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    if (this.manager.queryRunner?.isTransactionActive) return work(this)',
          '    return this.manager.transaction((manager) => work(new SqlUnitOfWork(manager)))',
          '  }',
        ]
      : [
          `  /** ${context.settings.transactions === 'caller' ? 'The transaction belongs to whoever created the manager' : 'Every write is committed at once'}: this only groups the code. */`,
          '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    return work(this)',
          '  }',
        ],
    '}',
  ].flat()
}

function testDatabase(): GeneratedFile[] {
  return [
    {
      path: 'test/database.ts',
      content: [
        '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from the entities for every test. */',
        "import type { DataSource } from 'typeorm'",
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDataSource } from '../src/data-source.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        '',
        "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'sqlite::memory:'",
        '',
        '/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */',
        'export function useTestDatabase(): () => SqlUnitOfWork {',
        '  let dataSource: DataSource | undefined',
        '  beforeEach(async () => {',
        '    dataSource = createDataSource(TEST_DATABASE_URL)',
        '    await dataSource.initialize()',
        '    // Drops every table and creates them again from the entities',
        '    await dataSource.synchronize(true)',
        '  })',
        '  afterEach(async () => {',
        '    await dataSource?.destroy()',
        '  })',
        '  return () => new SqlUnitOfWork(dataSource!.manager)',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'test/database.test.ts',
      content: [
        '/** The tests run on the database they were asked to. */',
        "import { describe, expect, it } from 'vitest'",
        "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        '',
        'const sqlUow = useTestDatabase()',
        '',
        '/** The TypeORM driver of each scheme TEST_DATABASE_URL may have */',
        "const DRIVERS: Record<string, string> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', mariadb: 'mysql', sqlite: 'better-sqlite3' }",
        '',
        "describe('the test database', () => {",
        "  it('is the one TEST_DATABASE_URL names', () => {",
        "    expect(sqlUow().manager.connection.options.type).toBe(DRIVERS[TEST_DATABASE_URL.split(':')[0]])",
        '  })',
        '})',
        '',
      ].join('\n'),
    },
  ]
}

export const typeormOrm: TsOrm = {
  id: 'typeorm',
  label: 'TypeORM 0.3',
  plainEntities: false,
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through an EntityManager.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to the manager it was given.'}`,
    init: (_context, imports) => {
      imports.type('typeorm', 'EntityManager')
      return ['constructor(private readonly manager: EntityManager) {}']
    },
    body: typeormBody,
  },
  unitOfWork,
  unset: (target) => `${target} === undefined`,
  testDatabase,
  memoryTests: () => true,
  dependencies,
  devDependencies,
  defaultUrl,
  layout: (context) => [
    'src/data-source.ts     the TypeORM data source: DATABASE_URL' + (writesEntities(context) ? ' and every entity' : ''),
  ],
}
