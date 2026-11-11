"""TypeScript + TypeORM 0.3 (Strategy of common/orm.py): the data source and entities faithful to the database,
repositories over an EntityManager, a unit of work whose transaction is the manager's, and tests on a real database
created from the entities (SQLite in memory unless TEST_DATABASE_URL names another). Mirrors
web/src/core/generators/typescript/typeorm/index.ts."""

from ...types import lines
from ..common.context import repository_interface, sql_repository_class, writes_entities
from ..typescript import TsImports
from .database import database_files, default_url
from .repository import typeorm_body

VERSIONS = {
    "typeorm": "^0.3.27",
    "reflectMetadata": "^0.2.2",
    "pg": "^8.16.3",
    "mysql2": "^3.15.3",
    "betterSqlite3": "^12.4.1",
}


def _dependencies(context: dict) -> dict:
    deps = {"typeorm": VERSIONS["typeorm"], "reflect-metadata": VERSIONS["reflectMetadata"]}
    database = context["settings"]["database"]
    if database == "postgresql":
        deps["pg"] = VERSIONS["pg"]
    if database in ("mysql", "mariadb"):
        deps["mysql2"] = VERSIONS["mysql2"]
    if database == "sqlite":
        deps["better-sqlite3"] = VERSIONS["betterSqlite3"]
    return deps


def _dev_dependencies(context: dict) -> dict:
    # The tests run on SQLite in memory unless TEST_DATABASE_URL names another database
    if context["settings"]["database"] == "sqlite" or context["settings"]["tests"] == "none":
        return {}
    return {"better-sqlite3": VERSIONS["betterSqlite3"]}


def _unit_of_work(context: dict, imports: TsImports) -> list:
    imports.type("typeorm", "EntityManager")
    settings = context["settings"]
    interfaces = settings["repositoryInterfaces"]
    tables = context["tables"]
    if settings["transactions"] == "operation":
        transaction = [
            "  /** Runs `work` in a transaction of its own, or in the one already open. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    if (this.manager.queryRunner?.isTransactionActive) return work(this)",
            "    return this.manager.transaction((manager) => work(new SqlUnitOfWork(manager)))",
            "  }",
        ]
    else:
        owner = (
            "The transaction belongs to whoever created the manager"
            if settings["transactions"] == "caller"
            else "Every write is committed at once"
        )
        transaction = [
            f"  /** {owner}: this only groups the code. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    return work(this)",
            "  }",
        ]
    return [
        "/** The repositories over one EntityManager: the data source's, or the one of a transaction. */",
        "export class SqlUnitOfWork implements UnitOfWork {",
        *(
            f"  readonly {info['attr']}: {repository_interface(info) if interfaces else sql_repository_class(info)}"
            for info in tables
        ),
        "",
        "  constructor(readonly manager: EntityManager) {",
        *(f"    this.{info['attr']} = new {sql_repository_class(info)}(manager)" for info in tables),
        "  }",
        "",
        *transaction,
        "}",
    ]


TEST_DATABASE = [
    "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from the entities for every test. */",
    "import type { DataSource } from 'typeorm'",
    "import { afterEach, beforeEach } from 'vitest'",
    "import { createDataSource } from '../src/data-source.js'",
    "import { SqlUnitOfWork } from '../src/unit-of-work.js'",
    "",
    "export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'sqlite::memory:'",
    "",
    "/** Opens the test database, empty, before every test of the file that calls it, and closes it after each; returns the unit of work of the running test. */",
    "export function useTestDatabase(): () => SqlUnitOfWork {",
    "  let dataSource: DataSource | undefined",
    "  beforeEach(async () => {",
    "    dataSource = createDataSource(TEST_DATABASE_URL)",
    "    await dataSource.initialize()",
    "    // Drops every table and creates them again from the entities",
    "    await dataSource.synchronize(true)",
    "  })",
    "  afterEach(async () => {",
    "    await dataSource?.destroy()",
    "  })",
    "  return () => new SqlUnitOfWork(dataSource!.manager)",
    "}",
    "",
]

DATABASE_TEST = [
    "/** The tests run on the database they were asked to. */",
    "import { describe, expect, it } from 'vitest'",
    "import { TEST_DATABASE_URL, useTestDatabase } from './database.js'",
    "",
    "const sqlUow = useTestDatabase()",
    "",
    "/** The TypeORM driver of each scheme TEST_DATABASE_URL may have */",
    "const DRIVERS: Record<string, string> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', mariadb: 'mysql', sqlite: 'better-sqlite3' }",
    "",
    "describe('the test database', () => {",
    "  it('is the one TEST_DATABASE_URL names', () => {",
    "    expect(sqlUow().manager.connection.options.type).toBe(DRIVERS[TEST_DATABASE_URL.split(':')[0]])",
    "  })",
    "})",
    "",
]


def _test_database(_context: dict) -> list[dict]:
    return [
        {"path": "test/database.ts", "content": lines(*TEST_DATABASE)},
        {"path": "test/database.test.ts", "content": lines(*DATABASE_TEST)},
    ]


def _doc(context: dict, info: dict) -> str:
    if context["settings"]["transactions"] == "repository":
        how = " Every write is committed at once."
    else:
        how = " It never commits: the transaction belongs to the manager it was given."
    return f"Keeps {info['name']} rows in the database, through an EntityManager.{how}"


def _init(_context: dict, imports: TsImports) -> list:
    imports.type("typeorm", "EntityManager")
    return ["constructor(private readonly manager: EntityManager) {}"]


def _layout(context: dict) -> list[str]:
    return [
        "src/data-source.ts     the TypeORM data source: DATABASE_URL"
        + (" and every entity" if writes_entities(context) else "")
    ]


TYPEORM_ORM = {
    "id": "typeorm",
    "label": "TypeORM 0.3",
    "databaseFiles": database_files,
    "repository": {"doc": _doc, "init": _init, "body": typeorm_body},
    "unitOfWork": _unit_of_work,
    "unset": lambda target: f"{target} === undefined",
    "testDatabase": _test_database,
    "dependencies": _dependencies,
    "devDependencies": _dev_dependencies,
    "defaultUrl": default_url,
    "layout": _layout,
}
