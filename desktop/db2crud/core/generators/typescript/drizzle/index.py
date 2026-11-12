"""TypeScript + Drizzle 0.45 (Strategy of common/orm.py): tables that reflect the database (src/schema.ts), the database
through the driver of each kind (node-postgres, mysql2, better-sqlite3), plain entities the repositories fill from
Drizzle's rows, a unit of work whose transaction is the database's, and tests on a database created from the tables
with the SQL drizzle-kit writes (SQLite in memory, or the database TEST_DATABASE_URL names: the tables are written for
one kind of database). Mirrors web/src/core/generators/typescript/drizzle/index.ts."""

from ...types import lines
from ..common.context import repository_interface, sql_repository_class, writes_entities
from ..common.entities import plain_entity_file
from ..typescript import TsImports, quote
from .repository import drizzle_body, drizzle_helpers
from .schema import column_types_file, dialect_of, schema_file

VERSIONS = {
    "drizzleOrm": "^0.45.4",
    "drizzleKit": "^0.31.11",
    "pg": "^8.16.3",
    "typesPg": "^8.15.5",
    "mysql2": "^3.15.3",
    "betterSqlite3": "^12.4.1",
    "typesBetterSqlite3": "^7.6.13",
}

LABELS = {"postgresql": "PostgreSQL", "mysql": "MySQL or MariaDB", "sqlite": "SQLite"}

URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mysql://app:app@localhost:3306/app",
    "sqlite": "file:./app.db",
}


def _default_url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


# The lines of src/database.ts that change with the database: its driver, its types and how it says no
DRIVERS = {
    "postgresql": {
        "imports": ["import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'", "import pg from 'pg'"],
        "types": [
            "/** The database: queries through a pool of connections (close it with `db.$client.end()`). */",
            "export type Db = NodePgDatabase & { $client: pg.Pool }",
            "",
            "/** The database or one of its transactions: what the repositories run their queries on. */",
            "export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]",
        ],
        "create": ["  return drizzle(new pg.Pool({ connectionString: url }))"],
        # SQLSTATE class 23: integrity constraint violation
        "refusal": "  return typeof code === 'string' && code.startsWith('23')",
    },
    "mysql": {
        "imports": [
            "import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'",
            "import mysql from 'mysql2/promise'",
        ],
        "types": [
            "/** The database: queries through a pool of connections (close it with `db.$client.end()`). */",
            "export type Db = MySql2Database & { $client: mysql.Pool }",
            "",
            "/** The database or one of its transactions: what the repositories run their queries on. */",
            "export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]",
        ],
        "create": [
            "  // MariaDB addresses work as mysql:// ones; whole numbers come back as numbers, and dates in UTC",
            "  const uri = url.replace(/^mariadb:/, 'mysql:')",
            "  return drizzle(mysql.createPool({ uri, supportBigNumbers: true, bigNumberStrings: false, timezone: 'Z' }))",
        ],
        "refusal": "  return typeof sqlState === 'string' && sqlState.startsWith('23')",
    },
    "sqlite": {
        "imports": [
            "import Database from 'better-sqlite3'",
            "import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'",
        ],
        "types": [
            "/** The database: one connection (close it with `db.$client.close()`). */",
            "export type Db = BetterSQLite3Database & { $client: Database.Database }",
            "",
            "/** What the repositories run their queries on: SQLite has one connection, so transactions run on it too. */",
            "export type Executor = Db",
        ],
        "create": [
            "  const file = url.replace(/^file:/, '')",
            "  const client = new Database(file === '' || file === ':memory:' ? ':memory:' : file)",
            "  // SQLite checks foreign keys only when asked to",
            "  client.pragma('foreign_keys = ON')",
            "  return drizzle(client)",
        ],
        "refusal": "  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')",
    },
}


def _database_file(context: dict) -> dict:
    """src/database.ts: the database DATABASE_URL names, the types the repositories run on, and its refusals."""
    dialect = dialect_of(context)
    driver = DRIVERS[dialect]
    field = "sqlState" if dialect == "mysql" else "code"
    if dialect == "sqlite":
        doc = "/** The SQLite database at `url` (file:<path>, or file::memory: for one in memory). */"
    else:
        doc = f"/** The {LABELS[dialect]} database at `url`. */"
    return {
        "path": "src/database.ts",
        "content": lines(
            f"/** The {LABELS[dialect]} database DATABASE_URL names (see .env.example), through Drizzle. */",
            "import { DrizzleQueryError } from 'drizzle-orm'",
            *driver["imports"],
            "",
            f"export const DATABASE_URL = process.env.DATABASE_URL ?? {quote(_default_url(context))}",
            "",
            *driver["types"],
            "",
            doc,
            "export function createDatabase(url: string = DATABASE_URL): Db {",
            *driver["create"],
            "}",
            "",
            "/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
            "export function isRefusal(error: unknown): boolean {",
            "  const cause = error instanceof DrizzleQueryError ? error.cause : error",
            f"  const {field} = (cause as {{ {field}?: unknown }} | undefined)?.{field}",
            driver["refusal"],
            "}",
            "",
        ),
    }


def _config_file(context: dict) -> dict:
    return {
        "path": "drizzle.config.ts",
        "content": lines(
            "/** Where drizzle-kit finds the tables and the database (DATABASE_URL), for `drizzle-kit studio` or `pull`. Never push or migrate: the database already exists. */",
            "import { defineConfig } from 'drizzle-kit'",
            "",
            "export default defineConfig({",
            f"  dialect: '{dialect_of(context)}',",
            "  schema: './src/schema.ts',",
            f"  dbCredentials: {{ url: process.env.DATABASE_URL ?? {quote(_default_url(context))} }},",
            "})",
            "",
        ),
    }


def _database_files(context: dict) -> list[dict]:
    files = [_database_file(context)]
    if writes_entities(context):
        files += [schema_file(context), column_types_file(context), _config_file(context)]
        where = "Its table is in src/schema.ts."
    else:
        where = "Its table comes from the Drizzle tables the project imports."
    files += [plain_entity_file(context, info, where) for info in context["tables"]]
    return [file for file in files if file is not None]


def _unit_of_work(context: dict, imports: TsImports) -> list:
    sqlite = dialect_of(context) == "sqlite"
    imports.type("src/database", "Db" if sqlite else "Executor")
    settings = context["settings"]
    interfaces = settings["repositoryInterfaces"]
    operation = settings["transactions"] == "operation"
    executor = "Db" if sqlite else "Executor"
    if operation and sqlite:
        imports.from_("drizzle-orm", "sql")
    if operation and not sqlite:
        imports.type("src/database", "Db")
    if operation:
        constructor = [
            "  constructor(",
            f"    readonly db: {executor},",
            "    private readonly inTransaction = false,",
            "  ) {",
        ]
        if sqlite:
            transaction = [
                "  /** Runs `work` in a transaction of its own, or in the one already open. */",
                "  async transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
                "    if (this.inTransaction) return work(this)",
                "    // better-sqlite3 has one connection and Drizzle's transactions on it cannot wait for promises: the",
                "    // transaction is opened and closed here",
                "    this.db.run(sql`BEGIN`)",
                "    try {",
                "      const result = await work(new SqlUnitOfWork(this.db, true))",
                "      this.db.run(sql`COMMIT`)",
                "      return result",
                "    } catch (error) {",
                "      this.db.run(sql`ROLLBACK`)",
                "      throw error",
                "    }",
                "  }",
            ]
        else:
            transaction = [
                "  /** Runs `work` in a transaction of its own, or in the one already open. */",
                "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
                "    if (this.inTransaction) return work(this)",
                "    return (this.db as Db).transaction((db) => work(new SqlUnitOfWork(db, true)))",
                "  }",
            ]
    else:
        constructor = [f"  constructor(readonly db: {executor}) {{"]
        owner = (
            "The transaction belongs to whoever created the database (`db.transaction`)"
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
        "/** The repositories over one database: the application's, or one of its transactions. */",
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
        "  await db.execute(sql.raw('DROP SCHEMA IF EXISTS public CASCADE'))",
        "  await db.execute(sql.raw('CREATE SCHEMA public'))",
    ],
    "mysql": [
        "  // In a transaction, so every statement runs on the connection whose foreign key checks are off",
        "  await db.transaction(async (tx) => {",
        "    const [tables] = (await tx.execute(",
        "      sql.raw('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'),",
        "    )) as unknown as [{ name: string }[]]",
        "    await tx.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 0'))",
        "    for (const { name } of tables) await tx.execute(sql.raw(`DROP TABLE \\`${name}\\``))",
        "    await tx.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 1'))",
        "  })",
    ],
    "sqlite": [
        "  db.run(sql.raw('PRAGMA foreign_keys = OFF'))",
        "  const tables = db.all<{ name: string }>(sql.raw(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\"))",
        '  for (const { name } of tables) db.run(sql.raw(`DROP TABLE "${name}"`))',
        "  db.run(sql.raw('PRAGMA foreign_keys = ON'))",
    ],
}

# The test that proves which database ran: its name, or SQLite itself
WHICH = {
    "postgresql": [
        "    const result = await sqlUow().db.execute(sql`SELECT current_database() AS name`)",
        "    expect(result.rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "mysql": [
        "    const [rows] = (await sqlUow().db.execute(sql`SELECT DATABASE() AS name`)) as unknown as [{ name: string }[]]",
        "    expect(rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "sqlite": [
        "    const row = sqlUow().db.get<{ version: string }>(sql`SELECT sqlite_version() AS version`)",
        "    expect(row.version).toMatch(/^3\\./)",
    ],
}

KIT = {
    "postgresql": ("generateDrizzleJson", "generateMigration"),
    "mysql": ("generateMySQLDrizzleJson", "generateMySQLMigration"),
    "sqlite": ("generateSQLiteDrizzleJson", "generateSQLiteMigration"),
}


def _test_database(context: dict) -> list[dict]:
    dialect = dialect_of(context)
    sqlite = dialect == "sqlite"
    json_name, migration = KIT[dialect]
    run = "db.run" if sqlite else "await db.execute"
    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from src/schema.ts for every test. */"
        url = ["export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'file::memory:'"]
    else:
        doc = f"/** The test database: the {LABELS[dialect]} database TEST_DATABASE_URL names, created empty from src/schema.ts for every test. */"
        url = [
            "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
            "// The tables are written for one kind of database: the tests cannot fall back to SQLite",
            "if (TEST_DATABASE_URL === '')",
            f"  throw new Error('The database tests need a disposable {LABELS[dialect]} database: set TEST_DATABASE_URL (it is emptied)')",
        ]
    database = lines(
        doc,
        "import { sql } from 'drizzle-orm'",
        f"import {{ {json_name}, {migration} }} from 'drizzle-kit/api'",
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Db } from '../src/database.js'",
        "import * as schema from '../src/schema.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        "",
        *url,
        "",
        "/** The statements that create every table of src/schema.ts, as drizzle-kit writes them. */",
        "async function schemaSql(): Promise<string[]> {",
        f"  return {migration}(await {json_name}({{}}), await {json_name}(schema))",
        "}",
        "",
        "/** Drops every table of the test database. */",
        f"{'function' if sqlite else 'async function'} empty(db: Db): {'void' if sqlite else 'Promise<void>'} {{",
        *EMPTY[dialect],
        "}",
        "",
        "/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */",
        "export function useTestDatabase(): () => SqlUnitOfWork {",
        "  let db: Db | undefined",
        "  let statements: string[] | undefined",
        "  beforeEach(async () => {",
        "    statements ??= await schemaSql()",
        "    db = createDatabase(TEST_DATABASE_URL)",
        f"    {'' if sqlite else 'await '}empty(db)",
        f"    for (const statement of statements) {run}(sql.raw(statement))",
        "  })",
        "  afterEach(async () => {",
        "    db?.$client.close()" if sqlite else "    await db?.$client.end()",
        "  })",
        "  return () => new SqlUnitOfWork(db!)",
        "}",
        "",
    )
    test = lines(
        "/** The tests run on the database they were asked to. */",
        "import { sql } from 'drizzle-orm'",
        "import { describe, expect, it } from 'vitest'",
        "import { useTestDatabase } from './database.js'"
        if sqlite
        else "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
        "",
        "const sqlUow = useTestDatabase()",
        "",
        "describe('the test database', () => {",
        "  it('is SQLite', () => {" if sqlite else "  it('is the one TEST_DATABASE_URL names', async () => {",
        *WHICH[dialect],
        "  })",
        "})",
        "",
    )
    return [
        {"path": "test/database.ts", "content": database},
        {"path": "test/database.test.ts", "content": test},
    ]


def _dependencies(context: dict) -> dict:
    driver = {
        "postgresql": {"pg": VERSIONS["pg"]},
        "mysql": {"mysql2": VERSIONS["mysql2"]},
        "sqlite": {"better-sqlite3": VERSIONS["betterSqlite3"]},
    }
    return {"drizzle-orm": VERSIONS["drizzleOrm"], **driver[dialect_of(context)]}


def _dev_dependencies(context: dict) -> dict:
    dialect = dialect_of(context)
    if dialect == "postgresql":
        types = {"@types/pg": VERSIONS["typesPg"]}
    elif dialect == "sqlite":
        types = {"@types/better-sqlite3": VERSIONS["typesBetterSqlite3"]}
    else:
        types = {}
    return {**types, **({"drizzle-kit": VERSIONS["drizzleKit"]} if writes_entities(context) else {})}


def _doc(context: dict, info: dict) -> str:
    if context["settings"]["transactions"] == "repository":
        how = " Every write is committed at once."
    else:
        how = " It never commits: the transaction belongs to the database it was given."
    return f"Keeps {info['name']} rows in the database, through Drizzle.{how}"


def _init(context: dict, imports: TsImports) -> list:
    executor = "Db" if dialect_of(context) == "sqlite" else "Executor"
    imports.type("src/database", executor)
    return [f"constructor(private readonly db: {executor}) {{}}"]


def _layout(context: dict) -> list[str]:
    result = []
    if writes_entities(context):
        result += [
            "src/schema.ts          the Drizzle tables, as the database has them",
            "drizzle.config.ts      where drizzle-kit finds the tables and DATABASE_URL",
        ]
    return [*result, "src/database.ts        the database: DATABASE_URL, through its driver"]


DRIZZLE_ORM = {
    "id": "drizzle",
    "label": "Drizzle 0.45",
    "plainEntities": True,
    "databaseFiles": _database_files,
    "repository": {"doc": _doc, "helpers": drizzle_helpers, "init": _init, "body": drizzle_body},
    "unitOfWork": _unit_of_work,
    "unset": lambda target: f"{target} === undefined",
    "testDatabase": _test_database,
    "memoryTests": lambda context: dialect_of(context) == "sqlite",
    "dependencies": _dependencies,
    "devDependencies": _dev_dependencies,
    "defaultUrl": _default_url,
    "layout": _layout,
}
