"""Mongoose 8 on MongoDB as a TypeScript ORM strategy (common/orm.py): the models on a connection, repositories over
them, the transaction of each operation in a session, and tests on a database made empty for each one. Entities are
plain classes; nested documents are part of the entity that holds them, and have no repository of their own. Mirrors
web/src/core/generators/typescript/mongoose/index.ts."""

from ...types import lines
from ..common.context import repository_interface, sql_repository_class, writes_entities
from ..common.entities import plain_entity_file
from ..typescript import TsImports
from .models import models_file, models_module
from .repository import mongoose_body, mongoose_helpers

URL = "mongodb://localhost:27017/app"

VERSIONS = {"mongoose": "^8.19.0"}


def _database_file(context: dict) -> dict:
    """src/database.ts: the connection DATABASE_URL names and its models, and how values and errors are read."""
    module = models_module(context)
    target = f"./{module[len('src/') :]}.js" if module.startswith("src/") else module
    content = lines(
        "/** The MongoDB database DATABASE_URL names (see .env.example), through Mongoose. */",
        "import { createConnection, Error as MongooseError, type Connection } from 'mongoose'",
        "import { ConflictError, ValidationFailedError } from './errors.js'",
        f"import {{ defineModels, type Models }} from '{target}'",
        "",
        "export const DATABASE_URL = process.env.DATABASE_URL ?? 'mongodb://localhost:27017/app'",
        "",
        "/** The database: its connection (close it with `db.connection.close()`) and the model of every collection. */",
        "export interface Db {",
        "  connection: Connection",
        "  models: Models",
        "}",
        "",
        "/** The database at `url`. It creates no collection and no index: the database already exists. */",
        "export async function createDatabase(url: string = DATABASE_URL): Promise<Db> {",
        "  const connection = await createConnection(url, { autoIndex: false, autoCreate: false }).asPromise()",
        "  return { connection, models: defineModels(connection) }",
        "}",
        "",
        "/** Whether a text is an identifier of MongoDB: 24 hexadecimal digits. */",
        "export const isObjectId = (value: unknown): boolean => /^[0-9a-f]{24}$/i.test(String(value))",
        "",
        "/** A value of the driver as the entities keep it: identifiers, exact decimals and UUIDs as text, bytes as a Buffer, and the same inside documents and lists. */",
        "export function plain(value: unknown): unknown {",
        "  if (value === null || value === undefined || value instanceof Date || Buffer.isBuffer(value)) return value",
        "  if (Array.isArray(value)) return value.map(plain)",
        "  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]))",
        "  if (typeof value !== 'object') return typeof value === 'bigint' ? Number(value) : value",
        "  const { _bsontype: type } = value as { _bsontype?: string }",
        "  if (type === 'Binary' || type === 'UUID') {",
        "    const binary = value as { sub_type: number; value(): Uint8Array; toUUID(): { toString(): string } }",
        "    return binary.sub_type === 4 ? binary.toUUID().toString() : Buffer.from(binary.value())",
        "  }",
        "  if (type === 'Long' || type === 'Int32' || type === 'Double') return Number(value)",
        "  if (type !== undefined) return String(value)",
        "  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))",
        "}",
        "",
        "/** The domain error of a refused write: a repeated value, or values the schema or the validator of the collection do not take. */",
        "export function refusal(entity: string, error: unknown): unknown {",
        "  if (error instanceof MongooseError.ValidationError)",
        "    return new ValidationFailedError(",
        "      entity,",
        "      Object.entries(error.errors).map(([field, item]) => ({ field, message: item.message })),",
        "    )",
        "  const code = (error as { code?: unknown } | null)?.code",
        "  if (code === 11000 || code === 121) return new ConflictError(entity, `the database refused the change: ${(error as Error).message}`)",
        "  return error",
        "}",
        "",
    )
    return {"path": "src/database.ts", "content": content}


def _database_files(context: dict) -> list[dict]:
    files = [_database_file(context)]
    if writes_entities(context):
        files.append(models_file(context))
        where = "Its collection is a model of src/models.ts."
    else:
        where = "Its collection is a model of the Mongoose models the project imports."
    return [*files, *(plain_entity_file(context, info, where) for info in context["tables"])]


def _unit_of_work(context: dict, imports: TsImports) -> list:
    imports.type("src/database", "Db").type("mongoose", "ClientSession")
    interfaces = context["settings"]["repositoryInterfaces"]
    mode = context["settings"]["transactions"]
    if mode == "operation":
        transaction = [
            "  /** Runs `work` in a transaction of its own, or in the one already open. MongoDB has transactions on replica sets only. */",
            "  async transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    if (this.session) return work(this)",
            "    const session = await this.db.connection.startSession()",
            "    try {",
            "      return await session.withTransaction(() => work(new SqlUnitOfWork(this.db, session)))",
            "    } finally {",
            "      await session.endSession()",
            "    }",
            "  }",
        ]
    else:
        how = (
            "The transaction belongs to whoever gave its session"
            if mode == "caller"
            else "Every write is stored at once"
        )
        transaction = [
            f"  /** {how}: this only groups the code. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    return work(this)",
            "  }",
        ]
    return [
        "/** The repositories over one database and, when there is one, the session whose transaction every query runs in. */",
        "export class SqlUnitOfWork implements UnitOfWork {",
        *(
            f"  readonly {info['attr']}: {repository_interface(info) if interfaces else sql_repository_class(info)}"
            for info in context["tables"]
        ),
        "",
        "  constructor(",
        "    readonly db: Db,",
        "    readonly session: ClientSession | null = null,",
        "  ) {",
        *(f"    this.{info['attr']} = new {sql_repository_class(info)}(db, session)" for info in context["tables"]),
        "  }",
        "",
        *transaction,
        "}",
    ]


_TEST_DATABASE = [
    "/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty for every test. */",
    "import { afterEach, beforeEach } from 'vitest'",
    "import { createDatabase, type Db } from '../src/database.js'",
    "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
    "",
    "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
    "if (TEST_DATABASE_URL === '')",
    "  throw new Error('The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)')",
    "",
    "/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */",
    "export function useTestDatabase(): () => SqlUnitOfWork {",
    "  let db: Db | undefined",
    "  beforeEach(async () => {",
    "    db = await createDatabase(TEST_DATABASE_URL)",
    "    await db.connection.dropDatabase()",
    "    // The collections and their indexes, as the models have them",
    "    for (const model of Object.values(db.models)) {",
    "      await model.createCollection()",
    "      await model.createIndexes()",
    "    }",
    "  })",
    "  afterEach(async () => {",
    "    await db?.connection.close()",
    "  })",
    "  return () => new SqlUnitOfWork(db!)",
    "}",
    "",
]

_DATABASE_TEST = [
    "/** The tests run on the database they were asked to. */",
    "import { describe, expect, it } from 'vitest'",
    "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
    "",
    "const sqlUow = useTestDatabase()",
    "",
    "describe('the test database', () => {",
    "  it('is the one TEST_DATABASE_URL names', () => {",
    "    expect(sqlUow().db.connection.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    "  })",
    "})",
    "",
]


def _test_database(_context: dict) -> list[dict]:
    return [
        {"path": "test/database.ts", "content": lines(*_TEST_DATABASE)},
        {"path": "test/database.test.ts", "content": lines(*_DATABASE_TEST)},
    ]


def _doc(context: dict, info: dict) -> str:
    how = (
        " Every write is stored at once."
        if context["settings"]["transactions"] == "repository"
        else " Queries run in the session it was given."
    )
    return f"Keeps {info['name']} documents in the database, through Mongoose.{how}"


def _init(_context: dict, imports: TsImports) -> list:
    imports.type("src/database", "Db").type("mongoose", "ClientSession")
    return [
        "constructor(",
        "  private readonly db: Db,",
        "  private readonly session: ClientSession | null = null,",
        ") {}",
    ]


def _layout(context: dict) -> list[str]:
    models = "src/models.ts          the Mongoose models, as the database has the documents"
    return [
        *([models] if writes_entities(context) else []),
        "src/database.ts        the database: DATABASE_URL, its connection and models",
    ]


MONGOOSE_ORM = {
    "id": "mongoose",
    "label": "Mongoose 8",
    "plainEntities": True,
    "databaseFiles": _database_files,
    # The project's models live on a connection of their own: those of the input do not stand in for them
    "ownModels": True,
    "prefix": "Mongo",
    "repository": {"doc": _doc, "helpers": mongoose_helpers, "init": _init, "body": mongoose_body},
    "unitOfWork": _unit_of_work,
    "unset": lambda target: f"{target} === undefined",
    "testDatabase": _test_database,
    "memoryTests": lambda _context: False,
    "dependencies": lambda _context: {"mongoose": VERSIONS["mongoose"]},
    "devDependencies": lambda _context: {},
    "defaultUrl": lambda _context: URL,
    "layout": _layout,
}
