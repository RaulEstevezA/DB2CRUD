"""TypeScript + Sequelize 6 (Strategy of common/orm.py): models that reflect the database (src/models.ts), the database
through the driver of each kind (pg, mysql2, sqlite3), plain entities the repositories fill from the models' instances,
a unit of work whose transaction is Sequelize's, passed to every query, and tests on a database Sequelize creates from
the models (SQLite in memory, or the database TEST_DATABASE_URL names: the models are written for one kind of
database). Mirrors web/src/core/generators/typescript/sequelize/index.ts."""

from ...types import lines
from ..common.context import repository_interface, sql_repository_class, writes_entities
from ..common.entities import plain_entity_file
from ..typescript import TsImports, quote
from .models import dialect_of, models_file, models_module
from .repository import sequelize_body, sequelize_helpers

VERSIONS = {
    "sequelize": "^6.37.8",
    "pg": "^8.16.3",
    "pgHstore": "^2.3.4",
    "mysql2": "^3.15.3",
    "sqlite3": "^5.1.7",
}

LABELS = {"postgresql": "PostgreSQL", "mysql": "MySQL or MariaDB", "sqlite": "SQLite"}

URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mysql://app:app@localhost:3306/app",
    "sqlite": "sqlite:./app.db",
}


def _default_url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


CREATE = {
    "postgresql": [
        "  const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false, timezone: '+00:00' })"
    ],
    "mysql": [
        "  // MariaDB addresses work as mysql:// ones; whole numbers come back as numbers, and dates in UTC",
        "  const sequelize = new Sequelize(url.replace(/^mariadb:/, 'mysql:'), {",
        "    dialect: 'mysql',",
        "    logging: false,",
        "    timezone: '+00:00',",
        "    dialectOptions: { supportBigNumbers: true, bigNumberStrings: false },",
        "  })",
    ],
    "sqlite": [
        "  const file = url.replace(/^sqlite:(\\/\\/)?/, '')",
        "  const sequelize = new Sequelize({ dialect: 'sqlite', storage: file === '' ? ':memory:' : file, logging: false })",
    ],
}


def _database_file(context: dict) -> dict:
    """src/database.ts: the Sequelize instance of the database DATABASE_URL names, and its models."""
    dialect = dialect_of(context)
    module = models_module(context)
    target = f"./{module[len('src/') :]}.js" if module.startswith("src/") else module
    if dialect == "sqlite":
        doc = "/** The SQLite database at `url` (sqlite:<path>, or sqlite::memory: for one in memory). */"
    else:
        doc = f"/** The {LABELS[dialect]} database at `url`. */"
    return {
        "path": "src/database.ts",
        "content": lines(
            f"/** The {LABELS[dialect]} database DATABASE_URL names (see .env.example), through Sequelize. */",
            "import { Sequelize } from 'sequelize'",
            f"import {{ defineModels, type Models }} from '{target}'",
            "",
            f"export const DATABASE_URL = process.env.DATABASE_URL ?? {quote(_default_url(context))}",
            "",
            "/** The database: its Sequelize instance (close it with `db.sequelize.close()`) and the model of every table. */",
            "export interface Db {",
            "  sequelize: Sequelize",
            "  models: Models",
            "}",
            "",
            doc,
            "export function createDatabase(url: string = DATABASE_URL): Db {",
            *CREATE[dialect],
            "  return { sequelize, models: defineModels(sequelize) }",
            "}",
            "",
        ),
    }


def _database_files(context: dict) -> list[dict]:
    files = [_database_file(context)]
    if writes_entities(context):
        files.append(models_file(context))
        where = "Its table is a model of src/models.ts."
    else:
        where = "Its table is a model of the Sequelize models the project imports."
    files += [plain_entity_file(context, info, where) for info in context["tables"]]
    return files


def _unit_of_work(context: dict, imports: TsImports) -> list:
    imports.type("src/database", "Db").type("sequelize", "Transaction")
    settings = context["settings"]
    interfaces = settings["repositoryInterfaces"]
    mode = settings["transactions"]
    if mode == "operation":
        transaction = [
            "  /** Runs `work` in a transaction of its own, or in the one already open. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    if (this.current) return work(this)",
            "    return this.db.sequelize.transaction((transaction) => work(new SqlUnitOfWork(this.db, transaction)))",
            "  }",
        ]
    else:
        owner = (
            "The transaction belongs to whoever gave it (`current`)"
            if mode == "caller"
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
        "/** The repositories over one database and, when there is one, the transaction every query runs in. */",
        "export class SqlUnitOfWork implements UnitOfWork {",
        *(
            f"  readonly {info['attr']}: {repository_interface(info) if interfaces else sql_repository_class(info)}"
            for info in tables
        ),
        "",
        "  constructor(",
        "    readonly db: Db,",
        "    readonly current: Transaction | null = null,",
        "  ) {",
        *(f"    this.{info['attr']} = new {sql_repository_class(info)}(db, current)" for info in tables),
        "  }",
        "",
        *transaction,
        "}",
    ]


# How each kind of database is emptied before a test: its tables are dropped
EMPTY = {
    "postgresql": [
        "  await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE')",
        "  await db.sequelize.query('CREATE SCHEMA public')",
    ],
    "mysql": [
        "  // In a transaction, so every statement runs on the connection whose foreign key checks are off",
        "  await db.sequelize.transaction(async (transaction) => {",
        "    const [tables] = (await db.sequelize.query(",
        "      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',",
        "      { transaction },",
        "    )) as [{ name: string }[], unknown]",
        "    await db.sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction })",
        "    for (const { name } of tables) await db.sequelize.query(`DROP TABLE \\`${name}\\``, { transaction })",
        "    await db.sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction })",
        "  })",
    ],
    "sqlite": [
        "  await db.sequelize.query('PRAGMA foreign_keys = OFF')",
        "  const [tables] = (await db.sequelize.query(",
        "    \"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\",",
        "  )) as [{ name: string }[], unknown]",
        '  for (const { name } of tables) await db.sequelize.query(`DROP TABLE "${name}"`)',
        "  await db.sequelize.query('PRAGMA foreign_keys = ON')",
    ],
}

# The test that proves which database ran: its name, or SQLite itself
WHICH = {
    "postgresql": [
        "    const [rows] = (await sqlUow().db.sequelize.query('SELECT current_database() AS name')) as [{ name: string }[], unknown]",
        "    expect(rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "mysql": [
        "    const [rows] = (await sqlUow().db.sequelize.query('SELECT DATABASE() AS name')) as [{ name: string }[], unknown]",
        "    expect(rows[0].name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "sqlite": [
        "    const [rows] = (await sqlUow().db.sequelize.query('SELECT sqlite_version() AS version')) as [{ version: string }[], unknown]",
        "    expect(rows[0].version).toMatch(/^3\\./)",
    ],
}


def _test_database(context: dict) -> list[dict]:
    dialect = dialect_of(context)
    sqlite = dialect == "sqlite"
    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from the models for every test. */"
        url = ["export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'sqlite::memory:'"]
    else:
        doc = f"/** The test database: the {LABELS[dialect]} database TEST_DATABASE_URL names, created empty from the models for every test. */"
        url = [
            "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
            "// The models are written for one kind of database: the tests cannot fall back to SQLite",
            "if (TEST_DATABASE_URL === '')",
            f"  throw new Error('The database tests need a disposable {LABELS[dialect]} database: set TEST_DATABASE_URL (it is emptied)')",
        ]
    database = lines(
        doc,
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Db } from '../src/database.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        "",
        *url,
        "",
        "/** Drops every table of the test database. */",
        "async function empty(db: Db): Promise<void> {",
        *EMPTY[dialect],
        "}",
        "",
        "/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */",
        "export function useTestDatabase(): () => SqlUnitOfWork {",
        "  let db: Db | undefined",
        "  beforeEach(async () => {",
        "    db = createDatabase(TEST_DATABASE_URL)",
        "    await empty(db)",
        "    // Creates every table from the models",
        "    await db.sequelize.sync()",
        "  })",
        "  afterEach(async () => {",
        "    await db?.sequelize.close()",
        "  })",
        "  return () => new SqlUnitOfWork(db!)",
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
        "postgresql": {"pg": VERSIONS["pg"], "pg-hstore": VERSIONS["pgHstore"]},
        "mysql": {"mysql2": VERSIONS["mysql2"]},
        "sqlite": {"sqlite3": VERSIONS["sqlite3"]},
    }
    return {"sequelize": VERSIONS["sequelize"], **driver[dialect_of(context)]}


def _doc(context: dict, info: dict) -> str:
    if context["settings"]["transactions"] == "repository":
        how = " Every write is committed at once."
    else:
        how = " It never commits: queries run in the transaction it was given."
    return f"Keeps {info['name']} rows in the database, through Sequelize.{how}"


def _init(_context: dict, imports: TsImports) -> list:
    imports.type("src/database", "Db").type("sequelize", "Transaction")
    return [
        "constructor(",
        "  private readonly db: Db,",
        "  private readonly transaction: Transaction | null = null,",
        ") {}",
    ]


def _layout(context: dict) -> list[str]:
    result = (
        ["src/models.ts          the Sequelize models, as the database has them"] if writes_entities(context) else []
    )
    return [*result, "src/database.ts        the database: DATABASE_URL, its Sequelize instance and models"]


SEQUELIZE_ORM = {
    "id": "sequelize",
    "label": "Sequelize 6",
    "plainEntities": True,
    "databaseFiles": _database_files,
    "repository": {"doc": _doc, "helpers": sequelize_helpers, "init": _init, "body": sequelize_body},
    "unitOfWork": _unit_of_work,
    "unset": lambda target: f"{target} === undefined",
    "testDatabase": _test_database,
    "memoryTests": lambda context: dialect_of(context) == "sqlite",
    "dependencies": _dependencies,
    "devDependencies": lambda _context: {},
    "defaultUrl": _default_url,
    "layout": _layout,
}
