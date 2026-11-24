"""* Kotlin without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through JDBC over one Connection
(sql/database.ts holds the connection and the helpers), plain classes as entities, a unit of work whose transaction is the
connection's, and tests on a real database created from the schema's DDL (SQLite in a temporary file, or the database
TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors
web/src/core/generators/kotlin/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ..context import kt_file
from ..kotlin import KtImports, kt_string
from ..tests import test_path
from .database import sql_database_files, sql_entity_files
from .repository import sql_body, sql_head, sql_helpers

_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}

_TRANSACTION = [
    "    override fun <T> transaction(work: (UnitOfWork) -> T): T {",
    "        // Joins the transaction already open",
    "        if (!connection.autoCommit) return work(this)",
    "        connection.autoCommit = false",
    "        try {",
    "            val result = work(this)",
    "            connection.commit()",
    "            return result",
    "        } catch (error: Throwable) {",
    "            connection.rollback()",
    "            throw error",
    "        } finally {",
    "            connection.autoCommit = true",
    "        }",
    "    }",
]


def _test_database_file(context: dict) -> dict:
    """TestDatabase: the test database, with every table dropped and created again from the schema's DDL."""
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    imports = KtImports(context["base"])
    if sqlite:
        imports.add("java.io.File")

    def list_(name: str, doc: str, statements: list[str]):
        return [
            f"    /** {doc} */",
            f"    private val {name} = listOf(",
            *(f"        {kt_string(statement)}," for statement in statements),
            "    )",
            "",
        ]

    missing = kt_string(
        f"The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
    )
    return kt_file(
        test_path(context, "TestDatabase"),
        context["base"],
        imports.write(),
        [
            (
                "/** The test database: TEST_DATABASE_URL, or SQLite in a temporary file, created from the schema before every test. */"
                if sqlite
                else f"/** The test database: the {_NAMES.get(database)} database TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the schema before every test. */"
            ),
            "object TestDatabase {",
            *(
                list_(
                    "DROP",
                    "Removes every table, so the database starts empty.",
                    drop_statements(context["schema"], database),
                )
            ),
            *(
                list_(
                    "CREATE",
                    "Creates every table, in an order the database accepts.",
                    create_statements(context["schema"], database),
                )
            ),
            "    /** The repositories over the test database, with every table dropped and created again. */",
            "    fun open(): SqlUnitOfWork {",
            '        val url = System.getenv("TEST_DATABASE_URL")',
            *(
                [
                    '            ?: "jdbc:sqlite:${File.createTempFile("test", ".db").also { it.deleteOnExit() }.absolutePath}"'
                ]
                if sqlite
                else [
                    "        // The tables are written for one kind of database: the tests cannot fall back to SQLite",
                    f"        checkNotNull(url) {{ {missing} }}",
                ]
            ),
            '        val user = System.getenv("TEST_DATABASE_USER") ?: ""',
            '        val connection = AppDatabase.connect(url, user, System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
            "        connection.createStatement().use { statement -> (DROP + CREATE).forEach { statement.execute(it) } }",
            "        return SqlUnitOfWork(connection)",
            "    }",
            "}",
        ],
    )


def _database_test_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    sql = (
        "SELECT current_database()"
        if database == "postgresql"
        else ("SELECT sqlite_version()" if sqlite else "SELECT DATABASE()")
    )
    imports = KtImports(context["base"]).add(
        "kotlin.test.Test", ("kotlin.test.assertTrue" if sqlite else "kotlin.test.assertEquals")
    )
    return kt_file(
        test_path(context, "DatabaseTest"),
        context["base"],
        imports.write(),
        [
            "/** The tests run on the database they were asked to. */",
            "class DatabaseTest {",
            "    @Test",
            ("    fun isSqlite() {" if sqlite else "    fun isTheOneTestDatabaseUrlNames() {"),
            "        TestDatabase.open().connection.use { connection ->",
            f"            val value = Sql.one(connection, {kt_string(sql)}) {{ it.getString(1) }}",
            (
                '            assertTrue(value!!.startsWith("3."))'
                if sqlite
                else '            assertEquals(System.getenv("TEST_DATABASE_URL")!!.substringAfterLast("/").substringBefore("?"), value)'
            ),
            "        }",
            "    }",
            "}",
        ],
    )


SQL_ORM = {
    "id": "sql",
    "holder": {"name": "connection", "type": "Connection", "ktImport": "java.sql.Connection", "text": "connection"},
    "emptyList": lambda context: '"{}"' if context["settings"]["database"] == "postgresql" else '"[]"',
    "databaseFiles": sql_database_files,
    "entityFiles": sql_entity_files,
    "repository": {
        "imports": lambda *_: [],
        "doc": lambda context: (
            "with SQL through JDBC. Writes run in the transaction of whoever holds the connection, when there is one."
            if context["settings"]["transactions"] == "caller"
            else "with SQL through JDBC. A write joins the transaction already open, or is committed at once."
        ),
        "head": sql_head,
        "kept": lambda context: "connection" if context["settings"]["repositoryInterfaces"] else "held",
        "body": sql_body,
        "helpers": sql_helpers,
    },
    "transaction": lambda *_: _TRANSACTION,
    "testDatabaseFiles": lambda context: [_test_database_file(context), _database_test_file(context)],
    "openTest": lambda context: (
        [
            "// The caller owns the transaction: the test opens it, and it ends with the test",
            "uow.connection.autoCommit = false",
        ]
        if context["settings"]["transactions"] == "caller"
        else []
    ),
    "closeTest": ["if (!uow.connection.autoCommit) uow.connection.rollback()", "uow.connection.close()"],
    "dependencies": lambda _context, driver: [f'    runtimeOnly("{driver}")'],
    "readme": {
        "intro": "plain entities, repositories with their own SQL over a JDBC `Connection` and services",
        "layout": [
            "src/main/kotlin/app/AppDatabase.kt      the JDBC connection to DATABASE_URL",
            "src/main/kotlin/app/Sql.kt              how the repositories run SQL: values and refusals",
        ],
        "entities": "one entity per table",
        "table": "entity, repositories and service of each table",
    },
}
