"""TypeScript + Prisma 7 (Strategy of common/orm.py): a Prisma schema that reflects the database, the client through
the driver adapter of the chosen database, plain entities the repositories turn rows into, a unit of work whose
transaction is the client's, and tests on a database created from the schema by Prisma itself (SQLite in memory, or
the database TEST_DATABASE_URL names: a Prisma schema is for one kind of database). Mirrors
web/src/core/generators/typescript/prisma/index.ts."""

from ...types import lines
from ..common.context import repository_interface, sql_repository_class, writes_entities
from ..common.entities import plain_entity_file
from ..typescript import TsImports, quote
from .repository import client_module, prisma_body, prisma_helpers
from .schema import provider_of, schema_file

VERSION = "^7.10.1"

ADAPTERS = {
    "postgresql": {"package": "@prisma/adapter-pg", "name": "PrismaPg", "label": "PostgreSQL"},
    "mysql": {"package": "@prisma/adapter-mariadb", "name": "PrismaMariaDb", "label": "MySQL or MariaDB"},
    "sqlite": {"package": "@prisma/adapter-better-sqlite3", "name": "PrismaBetterSqlite3", "label": "SQLite"},
}

URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mysql://app:app@localhost:3306/app",
    "sqlite": "file:./app.db",
}


def _default_url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


def _adapter_of(context: dict) -> dict:
    return ADAPTERS[provider_of(context)]


def _database_file(context: dict) -> dict:
    """src/database.ts: the client of the database DATABASE_URL names, through the driver adapter."""
    adapter = _adapter_of(context)
    provider = provider_of(context)
    imports = (
        TsImports("src/database")
        .from_(adapter["package"], adapter["name"])
        .from_(client_module(context), "PrismaClient")
    )
    if provider == "postgresql":
        create = [f"  return new PrismaClient({{ adapter: new {adapter['name']}({{ connectionString: url }}) }})"]
    elif provider == "mysql":
        create = [
            "  // The MariaDB driver reads mysql:// addresses as mariadb://, and MySQL 8 checks passwords with the server key",
            "  const address = new URL(url.replace(/^mysql:/, 'mariadb:'))",
            "  if (!address.searchParams.has('allowPublicKeyRetrieval')) address.searchParams.set('allowPublicKeyRetrieval', 'true')",
            f"  return new PrismaClient({{ adapter: new {adapter['name']}(address.toString()) }})",
        ]
    else:
        create = [f"  return new PrismaClient({{ adapter: new {adapter['name']}({{ url }}) }})"]
    if provider == "sqlite":
        doc = "/** A client for the SQLite database at `url` (file:<path>, or file::memory: for one in memory). Close it with $disconnect(). */"
    else:
        doc = f"/** A client for the {adapter['label']} database at `url`. Close it with $disconnect(). */"
    return {
        "path": "src/database.ts",
        "content": lines(
            f"/** The Prisma client of the {adapter['label']} database DATABASE_URL names (see .env.example). */",
            imports.write(),
            "",
            f"export const DATABASE_URL = process.env.DATABASE_URL ?? {quote(_default_url(context))}",
            "",
            doc,
            "export function createClient(url: string = DATABASE_URL): PrismaClient {",
            *create,
            "}",
            "",
        ),
    }


def _config_file(context: dict) -> dict:
    return {
        "path": "prisma.config.ts",
        "content": lines(
            "/** Where the Prisma CLI finds the schema and the database (DATABASE_URL). */",
            "import { defineConfig } from 'prisma/config'",
            "",
            "export default defineConfig({",
            "  schema: 'prisma/schema.prisma',",
            f"  datasource: {{ url: process.env.DATABASE_URL ?? {quote(_default_url(context))} }},",
            "})",
            "",
        ),
    }


def _database_files(context: dict) -> list[dict]:
    files = [_database_file(context)]
    if writes_entities(context):
        files += [schema_file(context), _config_file(context)]
        where = "Its table is a model of prisma/schema.prisma."
    else:
        where = "Its table is a model of the Prisma schema the client comes from."
    files += [plain_entity_file(context, info, where) for info in context["tables"]]
    return files


def _unit_of_work(context: dict, imports: TsImports) -> list:
    imports.type(client_module(context), "Prisma")
    settings = context["settings"]
    interfaces = settings["repositoryInterfaces"]
    operation = settings["transactions"] == "operation"
    if operation:
        imports.type(client_module(context), "PrismaClient")
        constructor = [
            "  constructor(",
            "    readonly db: Prisma.TransactionClient,",
            "    private readonly inTransaction = false,",
            "  ) {",
        ]
        transaction = [
            "  /** Runs `work` in a transaction of its own, or in the one already open. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    if (this.inTransaction) return work(this)",
            "    return (this.db as PrismaClient).$transaction((db) => work(new SqlUnitOfWork(db, true)))",
            "  }",
        ]
    else:
        constructor = ["  constructor(readonly db: Prisma.TransactionClient) {"]
        owner = (
            "The transaction belongs to whoever created the client (`$transaction`)"
            if settings["transactions"] == "caller"
            else "Every write is committed at once"
        )
        transaction = [
            f"  /** {owner}: this only groups the code. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    return work(this)",
            "  }",
        ]
    tables = context["tables"]
    return [
        "/** The repositories over one Prisma client: the application's, or the one of a transaction. */",
        "export class SqlUnitOfWork implements UnitOfWork {",
        *(
            f"  readonly {info['attr']}: {repository_interface(info) if interfaces else sql_repository_class(info)}"
            for info in tables
        ),
        "",
        *constructor,
        *(f"    this.{info['attr']} = new {sql_repository_class(info)}(db)" for info in tables),
        "  }",
        "",
        *transaction,
        "}",
    ]


# How each kind of database is emptied before a test: its tables are dropped
EMPTY = {
    "postgresql": [
        "  await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE')",
        "  await client.$executeRawUnsafe('CREATE SCHEMA public')",
    ],
    "mysql": [
        "  const tables = await client.$queryRawUnsafe<{ name: string }[]>(",
        "    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',",
        "  )",
        "  // In a transaction, so every statement runs on the connection whose foreign key checks are off",
        "  await client.$transaction(async (db) => {",
        "    await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')",
        "    for (const { name } of tables) await db.$executeRawUnsafe(`DROP TABLE \\`${name}\\``)",
        "    await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')",
        "  })",
    ],
    "sqlite": [
        "  await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')",
        "  const tables = await client.$queryRawUnsafe<{ name: string }[]>(",
        "    \"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\",",
        "  )",
        '  for (const { name } of tables) await client.$executeRawUnsafe(`DROP TABLE "${name}"`)',
        "  await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')",
    ],
}

# The test that proves which database ran: its name, or SQLite itself
WHICH = {
    "postgresql": [
        "    const [row] = await sqlUow().db.$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name')",
        "    expect(row.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "mysql": [
        "    const [row] = await sqlUow().db.$queryRawUnsafe<{ name: string }[]>('SELECT DATABASE() AS name')",
        "    expect(row.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "sqlite": [
        "    const [row] = await sqlUow().db.$queryRawUnsafe<{ version: string }[]>('SELECT sqlite_version() AS version')",
        "    expect(row.version).toMatch(/^3\\./)",
    ],
}

SETUP = [
    "/** Before the tests: the SQL that creates the tables of prisma/schema.prisma, from Prisma itself, for test/database.ts. */",
    "import { execSync } from 'node:child_process'",
    "import type { TestProject } from 'vitest/node'",
    "",
    "declare module 'vitest' {",
    "  export interface ProvidedContext {",
    "    schemaSql: string[]",
    "  }",
    "}",
    "",
    "export default function setup(project: TestProject): void {",
    "  const script = execSync('npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script', {",
    "    encoding: 'utf8',",
    "    stdio: ['ignore', 'pipe', 'inherit'],",
    "    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },",
    "  })",
    "  // One statement at a time: the drivers run one per call",
    "  const statements = script",
    "    .split(/;\\s*$/m)",
    "    .map((statement) => statement.replace(/^--.*$/gm, '').trim())",
    "    .filter((statement) => statement.length > 0)",
    "  project.provide('schemaSql', statements)",
    "}",
    "",
]


def _test_database(context: dict) -> list[dict]:
    provider = provider_of(context)
    adapter = _adapter_of(context)
    module = client_module(context)
    client = f"../{module}.js" if module.startswith("src/") else module
    sqlite = provider == "sqlite"
    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from prisma/schema.prisma for every test. */"
        url = ["export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'file::memory:'"]
    else:
        doc = f"/** The test database: the {adapter['label']} database TEST_DATABASE_URL names, created empty from prisma/schema.prisma for every test. */"
        url = [
            "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
            "// The schema is for one kind of database: the tests cannot fall back to SQLite",
            "if (TEST_DATABASE_URL === '')",
            f"  throw new Error('The database tests need a disposable {adapter['label']} database: set TEST_DATABASE_URL (it is emptied)')",
        ]
    database = lines(
        doc,
        "import { afterEach, beforeEach, inject } from 'vitest'",
        "import { createClient } from '../src/database.js'",
        f"import type {{ PrismaClient }} from '{client}'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        "",
        *url,
        "",
        "/** Drops every table of the test database. */",
        "async function empty(client: PrismaClient): Promise<void> {",
        *EMPTY[provider],
        "}",
        "",
        "/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */",
        "export function useTestDatabase(): () => SqlUnitOfWork {",
        "  let client: PrismaClient | undefined",
        "  beforeEach(async () => {",
        "    client = createClient(TEST_DATABASE_URL)",
        "    await empty(client)",
        "    for (const statement of inject('schemaSql')) await client.$executeRawUnsafe(statement)",
        "  })",
        "  afterEach(async () => {",
        "    await client?.$disconnect()",
        "  })",
        "  return () => new SqlUnitOfWork(client!)",
        "}",
        "",
    )
    test = lines(
        "/** The tests run on the database they were asked to. */",
        "import { describe, expect, it } from 'vitest'",
        "import { useTestDatabase } from './database.js'"
        if sqlite
        else "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        "",
        "const sqlUow = useTestDatabase()",
        "",
        "describe('the test database', () => {",
        "  it('is SQLite', async () => {" if sqlite else "  it('is the one TEST_DATABASE_URL names', async () => {",
        *WHICH[provider],
        "  })",
        "})",
        "",
    )
    return [
        {"path": "test/setup.ts", "content": lines(*SETUP)},
        {"path": "test/database.ts", "content": database},
        {"path": "test/database.test.ts", "content": test},
    ]


def _doc(context: dict, info: dict) -> str:
    if context["settings"]["transactions"] == "repository":
        how = " Every write is committed at once."
    else:
        how = " It never commits: the transaction belongs to the client it was given."
    return f"Keeps {info['name']} rows in the database, through a Prisma client.{how}"


def _init(context: dict, imports: TsImports) -> list:
    imports.type(client_module(context), "Prisma")
    return ["constructor(private readonly db: Prisma.TransactionClient) {}"]


def _layout(context: dict) -> list[str]:
    result = []
    if writes_entities(context):
        result += [
            "prisma/schema.prisma   a model per table, as the database has it; the client is generated from it",
            "prisma.config.ts       where the Prisma CLI finds the schema and DATABASE_URL",
        ]
    return [*result, "src/database.ts        the Prisma client: DATABASE_URL, through the driver adapter"]


PRISMA_ORM = {
    "id": "prisma",
    "label": "Prisma 7",
    "plainEntities": True,
    "databaseFiles": _database_files,
    "repository": {"doc": _doc, "helpers": prisma_helpers, "init": _init, "body": prisma_body},
    "unitOfWork": _unit_of_work,
    "unset": lambda target: f"{target} === undefined",
    "testDatabase": _test_database,
    "memoryTests": lambda context: provider_of(context) == "sqlite",
    "testSetup": lambda context: (
        "test/setup.ts" if context["settings"]["tests"] != "none" and writes_entities(context) else None
    ),
    # The client is generated from the schema when the dependencies are installed
    "scripts": lambda context: {"postinstall": "prisma generate"} if writes_entities(context) else {},
    "ignored": lambda context: ["src/generated/"] if writes_entities(context) else [],
    "dependencies": lambda context: {"@prisma/client": VERSION, _adapter_of(context)["package"]: VERSION},
    "devDependencies": lambda context: {"prisma": VERSION} if writes_entities(context) else {},
    "defaultUrl": _default_url,
    "layout": _layout,
}
