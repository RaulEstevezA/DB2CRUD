/**
 * Mongoose 8 on MongoDB as a TypeScript ORM strategy (common/orm.ts): the models on a connection, repositories over
 * them, the transaction of each operation in a session, and tests on a database made empty for each one. Entities are
 * plain classes; nested documents are part of the entity that holds them, and have no repository of their own.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { quote, type TsImports } from '../typescript.ts'
import { repositoryInterface, sqlRepositoryClass, writesEntities, type Context } from '../common/context.ts'
import { plainEntityFile } from '../common/entities.ts'
import type { TsOrm } from '../common/orm.ts'
import { modelsFile, modelsModule } from './models.ts'
import { mongooseBody, mongooseHelpers } from './repository.ts'

const VERSIONS = { mongoose: '^8.19.0' }

const URL = 'mongodb://localhost:27017/app'

/** `src/database.ts`: the connection DATABASE_URL names and its models, and how values and errors are read. */
function databaseFile(context: Context): GeneratedFile {
  const module = modelsModule(context)
  const target = module.startsWith('src/') ? `./${module.slice('src/'.length)}.js` : module
  return {
    path: 'src/database.ts',
    content: lines(
      '/** The MongoDB database DATABASE_URL names (see .env.example), through Mongoose. */',
      "import { createConnection, Error as MongooseError, type Connection } from 'mongoose'",
      "import { ConflictError, ValidationFailedError } from './errors.js'",
      `import { defineModels, type Models } from '${target}'`,
      '',
      `export const DATABASE_URL = process.env.DATABASE_URL ?? ${quote(URL)}`,
      '',
      '/** The database: its connection (close it with `db.connection.close()`) and the model of every collection. */',
      'export interface Db {',
      '  connection: Connection',
      '  models: Models',
      '}',
      '',
      '/** The database at `url`. It creates no collection and no index: the database already exists. */',
      'export async function createDatabase(url: string = DATABASE_URL): Promise<Db> {',
      '  const connection = await createConnection(url, { autoIndex: false, autoCreate: false }).asPromise()',
      '  return { connection, models: defineModels(connection) }',
      '}',
      '',
      '/** Whether a text is an identifier of MongoDB: 24 hexadecimal digits. */',
      'export const isObjectId = (value: unknown): boolean => /^[0-9a-f]{24}$/i.test(String(value))',
      '',
      '/** A value of the driver as the entities keep it: identifiers, exact decimals and UUIDs as text, bytes as a Buffer, and the same inside documents and lists. */',
      'export function plain(value: unknown): unknown {',
      '  if (value === null || value === undefined || value instanceof Date || Buffer.isBuffer(value)) return value',
      '  if (Array.isArray(value)) return value.map(plain)',
      '  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]))',
      "  if (typeof value !== 'object') return typeof value === 'bigint' ? Number(value) : value",
      '  const { _bsontype: type } = value as { _bsontype?: string }',
      "  if (type === 'Binary' || type === 'UUID') {",
      '    const binary = value as { sub_type: number; value(): Uint8Array; toUUID(): { toString(): string } }',
      '    return binary.sub_type === 4 ? binary.toUUID().toString() : Buffer.from(binary.value())',
      '  }',
      "  if (type === 'Long' || type === 'Int32' || type === 'Double') return Number(value)",
      '  if (type !== undefined) return String(value)',
      '  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))',
      '}',
      '',
      '/** The domain error of a refused write: a repeated value, or values the schema or the validator of the collection do not take. */',
      'export function refusal(entity: string, error: unknown): unknown {',
      '  if (error instanceof MongooseError.ValidationError)',
      '    return new ValidationFailedError(',
      '      entity,',
      '      Object.entries(error.errors).map(([field, item]) => ({ field, message: item.message })),',
      '    )',
      '  const code = (error as { code?: unknown } | null)?.code',
      '  if (code === 11000 || code === 121) return new ConflictError(entity, `the database refused the change: ${(error as Error).message}`)',
      '  return error',
      '}',
      '',
    ),
  }
}

function databaseFiles(context: Context): GeneratedFile[] {
  const files = [databaseFile(context)]
  if (writesEntities(context)) files.push(modelsFile(context))
  const where = writesEntities(context)
    ? 'Its collection is a model of src/models.ts.'
    : 'Its collection is a model of the Mongoose models the project imports.'
  for (const info of context.tables) files.push(plainEntityFile(context, info, where))
  return files
}

function unitOfWork(context: Context, imports: TsImports): Line[] {
  imports.type('src/database', 'Db').type('mongoose', 'ClientSession')
  const interfaces = context.settings.repositoryInterfaces
  const mode = context.settings.transactions
  return [
    '/** The repositories over one database and, when there is one, the session whose transaction every query runs in. */',
    'export class SqlUnitOfWork implements UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${interfaces ? repositoryInterface(info) : sqlRepositoryClass(info)}`),
    '',
    '  constructor(',
    '    readonly db: Db,',
    '    readonly session: ClientSession | null = null,',
    '  ) {',
    ...context.tables.map((info) => `    this.${info.attr} = new ${sqlRepositoryClass(info)}(db, session)`),
    '  }',
    '',
    mode === 'operation'
      ? [
          '  /** Runs `work` in a transaction of its own, or in the one already open. MongoDB has transactions on replica sets only. */',
          '  async transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
          '    if (this.session) return work(this)',
          '    const session = await this.db.connection.startSession()',
          '    try {',
          '      return await session.withTransaction(() => work(new SqlUnitOfWork(this.db, session)))',
          '    } finally {',
          '      await session.endSession()',
          '    }',
          '  }',
        ]
      : [
          `  /** ${mode === 'caller' ? 'The transaction belongs to whoever gave its session' : 'Every write is stored at once'}: this only groups the code. */`,
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
      content: lines(
        '/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty for every test. */',
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Db } from '../src/database.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        '',
        "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
        "if (TEST_DATABASE_URL === '')",
        "  throw new Error('The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)')",
        '',
        '/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */',
        'export function useTestDatabase(): () => SqlUnitOfWork {',
        '  let db: Db | undefined',
        '  beforeEach(async () => {',
        '    db = await createDatabase(TEST_DATABASE_URL)',
        '    await db.connection.dropDatabase()',
        '    // The collections and their indexes, as the models have them',
        '    for (const model of Object.values(db.models)) {',
        '      await model.createCollection()',
        '      await model.createIndexes()',
        '    }',
        '  })',
        '  afterEach(async () => {',
        '    await db?.connection.close()',
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
        "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        '',
        'const sqlUow = useTestDatabase()',
        '',
        "describe('the test database', () => {",
        "  it('is the one TEST_DATABASE_URL names', () => {",
        '    expect(sqlUow().db.connection.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))',
        '  })',
        '})',
        '',
      ),
    },
  ]
}

export const mongooseOrm: TsOrm = {
  id: 'mongoose',
  label: 'Mongoose 8',
  plainEntities: true,
  databaseFiles,
  // The project's models live on a connection of their own: those of the input do not stand in for them
  ownModels: true,
  prefix: 'Mongo',
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} documents in the database, through Mongoose.${context.settings.transactions === 'repository' ? ' Every write is stored at once.' : ' Queries run in the session it was given.'}`,
    helpers: mongooseHelpers,
    init: (_context, imports) => {
      imports.type('src/database', 'Db').type('mongoose', 'ClientSession')
      return ['constructor(', '  private readonly db: Db,', '  private readonly session: ClientSession | null = null,', ') {}']
    },
    body: mongooseBody,
  },
  unitOfWork,
  unset: (target) => `${target} === undefined`,
  testDatabase,
  memoryTests: () => false,
  dependencies: () => ({ mongoose: VERSIONS.mongoose }),
  devDependencies: () => ({}),
  defaultUrl: () => URL,
  layout: (context) =>
    [
      writesEntities(context) && 'src/models.ts          the Mongoose models, as the database has the documents',
      'src/database.ts        the database: DATABASE_URL, its connection and models',
    ].filter((line): line is string => typeof line === 'string'),
}
