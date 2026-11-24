"""* Swift without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through SQLKit and the driver of
the database (sql/database.ts holds the pool and the helpers), plain structs as entities, a unit of work whose transaction
is a connection's, and tests on a real database created from the schema's DDL (SQLite in memory, or the database
TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors
web/src/core/generators/swift/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ..context import uses_times
from ..swift import sw_string
from ..tests import NAMES
from .database import database_file, driver_of, entity_file
from .repository import sql_body, sql_functions

_VERSIONS = {
    "sql": "3.36.0",
    "postgres": "2.17.0",
    "mysql": "4.10.2",
    "sqlite": "4.5.2",
    "async": "1.22.0",
    "nio": "2.105.0",
    "log": "1.17.2",
    "postgresNio": "1.33.3",
}

_PACKAGES = {
    "PostgresKit": {"name": "postgres-kit", "version": _VERSIONS["postgres"]},
    "MySQLKit": {"name": "mysql-kit", "version": _VERSIONS["mysql"]},
    "SQLiteKit": {"name": "sqlite-kit", "version": _VERSIONS["sqlite"]},
}


def _test_database(context: dict):
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    missing = sw_string(
        f"The database tests need a disposable {NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
    )
    check = (
        "SELECT current_database()::text AS value"
        if database == "postgresql"
        else ("SELECT sqlite_version() AS value" if sqlite else "SELECT DATABASE() AS value")
    )

    def list_(name: str, doc: str, statements: list[str]):
        return [
            "",
            f"    /// {doc}",
            f"    private static let {name}: [String] = [",
            *(f"        {sw_string(statement)}," for statement in statements),
            "    ]",
        ]

    drop = list_(
        "drop", "Removes every table, so the database starts empty.", drop_statements(context["schema"], database)
    )
    create = list_(
        "create",
        "Creates every table, in an order the database accepts.",
        create_statements(context["schema"], database),
    )
    return {
        "modules": ["SQLKit", *(["SQLiteKit"] if sqlite else [])],
        "open": (
            [
                '        let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"]',
                "        let app = if let url { AppDatabase(url: url) } else { AppDatabase(configuration: SQLiteConfiguration(storage: .memory)) }",
            ]
            if sqlite
            else [
                "        // The tables are written for one kind of database: the tests cannot fall back to SQLite",
                f'        let url = try #require(ProcessInfo.processInfo.environment["TEST_DATABASE_URL"], {missing})',
                "        let app = try AppDatabase(url: url)",
            ]
        ),
        "recreate": [
            "    /// Drops every table and creates them again; on one connection, as MySQL turns its foreign key checks off for the connection that asks.",
            "    private static func recreate(_ db: Db) async throws {",
            "        try await db.sql.withSession { session in",
            '            for statement in drop + create { try await session.raw("\\(unsafeRaw: statement)").run() }',
            "        }",
            "    }",
            *drop,
            *create,
        ],
        "check": f"uow.db.sql.raw({sw_string(check)}).all()",
    }


def _url(owner: str, name: str, version: str):
    return f'.package(url: "https://github.com/{owner}/{name}.git", from: "{version}"),'


def _product(name: str, pkg: str):
    return f'.product(name: "{name}", package: "{pkg}")'


def _packages(context: dict):
    driver = driver_of(context)["module"]
    pkg = _PACKAGES.get(driver)
    # TimeOfDay says how PostgreSQL keeps it
    times = context["settings"]["database"] == "postgresql" and uses_times(context)
    return {
        "packages": [
            _url("vapor", "sql-kit", _VERSIONS["sql"]),
            _url("vapor", pkg["name"], pkg["version"]),
            _url("vapor", "async-kit", _VERSIONS["async"]),
            _url("apple", "swift-nio", _VERSIONS["nio"]),
            _url("apple", "swift-log", _VERSIONS["log"]),
            *([_url("vapor", "postgres-nio", _VERSIONS["postgresNio"])] if times else []),
        ],
        "products": [
            _product("SQLKit", "sql-kit"),
            _product(driver, pkg["name"]),
            _product("AsyncKit", "async-kit"),
            _product("NIOCore", "swift-nio"),
            _product("NIOPosix", "swift-nio"),
            _product("Logging", "swift-log"),
            *([_product("PostgresNIO", "postgres-nio")] if times else []),
        ],
        "testProducts": [_product("SQLKit", "sql-kit"), _product(driver, pkg["name"])],
    }


SQL_ORM = {
    "id": "sql",
    "label": "SQLKit",
    "holder": {"type": "Db", "optional": "Db?", "modules": []},
    "emptyList": lambda context: '"{}"' if context["settings"]["database"] == "postgresql" else '"[]"',
    "databaseFile": database_file,
    "entityFiles": lambda context, info: [entity_file(context, info)],
    "repository": {
        "modules": lambda *_: ["SQLKit"],
        "body": lambda context, info, method: sql_body(context, info, method),
        "refusal": "let error where isRefusal(error)",
        "functions": sql_functions,
    },
    "transaction": "try await db.transaction { transaction in try await work(SqlUnitOfWork(db: transaction)) }",
    "testDatabase": _test_database,
    "packages": _packages,
    "readme": {
        "intro": f"plain entities, repositories with their own SQL through SQLKit {_VERSIONS['sql']} and services",
        "entities": "one entity per table",
        "table": "entity, repositories and service of each table",
    },
}
