"""TypeScript without an ORM (Strategy of common/orm.py): repositories that write their SQL, through each database's
driver (node-postgres, mysql2, better-sqlite3) behind one small interface (sql/database.py); plain classes as entities;
a unit of work whose transaction is the database's; and tests on a real database created from the schema's DDL (SQLite
in memory, or the database TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors
web/src/core/generators/typescript/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ...types import lines
from ..common.context import repository_interface, sql_repository_class
from ..typescript import TsImports, quote
from .database import DRIVER_LABELS, LABELS, database_files, default_url, dialect_of
from .repository import sql_body, sql_helpers

VERSIONS = {
    "pg": "^8.16.3",
    "typesPg": "^8.15.5",
    "mysql2": "^3.15.3",
    "betterSqlite3": "^12.4.1",
    "typesBetterSqlite3": "^7.6.13",
}


def _unit_of_work(context: dict, imports: TsImports) -> list:
    imports.type("src/database", "Db")
    settings = context["settings"]
    interfaces = settings["repositoryInterfaces"]
    transactions = settings["transactions"]
    if transactions == "operation":
        transaction = [
            "  /** Runs `work` in a transaction of its own, or in the one already open. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    return this.db.transaction((db) => work(new SqlUnitOfWork(db)))",
            "  }",
        ]
    else:
        owner = (
            "The transaction belongs to whoever created the unit of work (`db.transaction`)"
            if transactions == "caller"
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
        "  constructor(readonly db: Db) {",
        *(f"    this.{info['attr']} = new {sql_repository_class(info)}(db)" for info in tables),
        "  }",
        "",
        *transaction,
        "}",
    ]


def _schema_file(context: dict) -> dict:
    """test/schema.ts: the SQL that removes and creates the tables of the test database."""
    database = context["settings"]["database"]

    def listed(name: str, doc: str, statements: list[str]) -> list[str]:
        items = (f"  {quote(statement).replace(chr(10), chr(92) + 'n')}," for statement in statements)
        return [f"/** {doc} */", f"export const {name}: string[] = [", *items, "]"]

    return {
        "path": "test/schema.ts",
        "content": lines(
            "/** The tables of the test database, as the schema DB2CRUD read has them. */",
            "",
            *listed(
                "DROP",
                "Removes every table, so the database starts empty.",
                drop_statements(context["schema"], database),
            ),
            "",
            *listed(
                "CREATE",
                "Creates every table, in an order the database accepts.",
                create_statements(context["schema"], database),
            ),
            "",
        ),
    }


# The test that proves which database ran: its name, or SQLite itself
WHICH = {
    "postgresql": [
        "    const row = await sqlUow().db.one('SELECT current_database() AS name')",
        "    expect(row?.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "mysql": [
        "    const row = await sqlUow().db.one('SELECT DATABASE() AS name')",
        "    expect(row?.name).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1))",
    ],
    "sqlite": [
        "    const row = await sqlUow().db.one('SELECT sqlite_version() AS version')",
        "    expect(row?.version).toMatch(/^3\\./)",
    ],
}


def _test_database(context: dict) -> list[dict]:
    dialect = dialect_of(context)
    sqlite = dialect == "sqlite"
    label = LABELS[dialect]
    if sqlite:
        heading = "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from test/schema.ts for every test. */"
        url = ["export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'file::memory:'"]
    else:
        heading = f"/** The test database: the {label} database TEST_DATABASE_URL names, created empty from test/schema.ts for every test. */"
        url = [
            "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''",
            "// The tables are written for one kind of database: the tests cannot fall back to SQLite",
            "if (TEST_DATABASE_URL === '')",
            f"  throw new Error('The database tests need a disposable {label} database: set TEST_DATABASE_URL (it is emptied)')",
        ]
    database = lines(
        heading,
        "import { afterEach, beforeEach } from 'vitest'",
        "import { createDatabase, type Database } from '../src/database.js'",
        "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
        "import { CREATE, DROP } from './schema.js'",
        "",
        *url,
        "",
        "/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */",
        "export function useTestDatabase(): () => SqlUnitOfWork {",
        "  let db: Database | undefined",
        "  beforeEach(async () => {",
        "    db = createDatabase(TEST_DATABASE_URL)",
        "    // On one connection: MySQL turns its foreign key checks off for the connection that asks",
        "    await db.transaction(async (connection) => {",
        "      for (const statement of [...DROP, ...CREATE]) await connection.run(statement)",
        "    })",
        "  })",
        "  afterEach(async () => {",
        "    await db?.close()",
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
        _schema_file(context),
        {"path": "test/database.ts", "content": database},
        {"path": "test/database.test.ts", "content": test},
    ]


_DEPENDENCIES = {
    "postgresql": {"pg": VERSIONS["pg"]},
    "mysql": {"mysql2": VERSIONS["mysql2"]},
    "sqlite": {"better-sqlite3": VERSIONS["betterSqlite3"]},
}

_DEV_DEPENDENCIES = {
    "postgresql": {"@types/pg": VERSIONS["typesPg"]},
    "mysql": {},
    "sqlite": {"@types/better-sqlite3": VERSIONS["typesBetterSqlite3"]},
}


def _doc(context: dict, info: dict) -> str:
    if context["settings"]["transactions"] == "repository":
        how = " Every write is committed at once."
    else:
        how = " It never commits: the transaction belongs to the database it was given."
    return f"Keeps {info['name']} rows in the database, with SQL through {DRIVER_LABELS[dialect_of(context)]}.{how}"


def _init(_context: dict, imports: TsImports) -> list:
    imports.type("src/database", "Db")
    return ["constructor(private readonly db: Db) {}"]


SQL_ORM = {
    "id": "sql",
    "label": "SQL",
    "plainEntities": False,
    "databaseFiles": database_files,
    "repository": {"doc": _doc, "helpers": sql_helpers, "init": _init, "body": sql_body},
    "unitOfWork": _unit_of_work,
    "unset": lambda target: f"{target} === undefined",
    "testDatabase": _test_database,
    "memoryTests": lambda context: dialect_of(context) == "sqlite",
    "dependencies": lambda context: dict(_DEPENDENCIES[dialect_of(context)]),
    "devDependencies": lambda context: dict(_DEV_DEPENDENCIES[dialect_of(context)]),
    "defaultUrl": default_url,
    "layout": lambda context: [
        "src/database.ts        the database: DATABASE_URL, through its driver, and the calls that run SQL"
    ],
}
