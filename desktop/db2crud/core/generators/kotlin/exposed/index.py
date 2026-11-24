"""* Kotlin + Exposed 1.6 (Strategy of orm.ts): entities and table objects as the database has them, repositories with
Exposed's DSL, a unit of work whose transaction is Exposed's, and tests on a database created from the table objects. Mirrors
web/src/core/generators/kotlin/exposed/index.ts."""

import re

from ..context import kt_file, package_of, path_of, qualified
from ..kotlin import KtImports, kt_string
from ..support import default_url
from ..tests import test_path
from .entities import entity_file, enum_column_file, native_enum, table_object_file, uses_enum_columns
from .repository import exposed_body, exposed_helpers

_EXPOSED = "1.6.1"

# Exposed's transaction, by another name than the unit of work's own transaction().
_EXPOSED_TRANSACTION = "org.jetbrains.exposed.v1.jdbc.transactions.transaction as exposedTransaction"


def _database_file(context: dict) -> dict:
    """AppDatabase: the database DATABASE_URL names (with DATABASE_USER and DATABASE_PASSWORD)."""
    pkg = context["base"]
    return kt_file(
        path_of(pkg, "AppDatabase"),
        pkg,
        "import org.jetbrains.exposed.v1.jdbc.Database",
        [
            "/** The database DATABASE_URL names (a JDBC URL), through Exposed. It never migrates: the database already exists. */",
            "object AppDatabase {",
            f"    const val DEFAULT_URL = {kt_string(default_url(context))}",
            "",
            "    /** A connection to the database at url (DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD, by default). */",
            "    fun connect(",
            '        url: String = System.getenv("DATABASE_URL") ?: DEFAULT_URL,',
            '        user: String = System.getenv("DATABASE_USER") ?: "",',
            '        password: String = System.getenv("DATABASE_PASSWORD") ?: "",',
            "    ): Database = Database.connect(url, user = user, password = password)",
            "}",
        ],
    )


_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_files(context: dict) -> list[dict]:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    imports = KtImports(context["base"]).add(
        "org.jetbrains.exposed.v1.jdbc.Database", "org.jetbrains.exposed.v1.jdbc.SchemaUtils", _EXPOSED_TRANSACTION
    )
    tables = [info for info in context["tables"] if info["writesEntity"]]
    for info in tables:
        imports.add(qualified(package_of(context, info, "entity"), info["tableObject"]))
    postgres = database == "postgresql"
    schemas = (
        list(
            dict.fromkeys(name for name in [info["table"].get("schema") for info in context["tables"]] if not not name)
        )
        if postgres
        else []
    )
    enums = (
        [
            item
            for item in context["schema"]["enums"]
            if any(
                any(native_enum(context, column["column"]) == item for column in info["columns"])
                for info in context["tables"]
            )
        ]
        if postgres
        else []
    )

    def quote(text: str):
        return "'" + re.sub(r"'", "''", text) + "'"

    def statement(sql: str):
        return f"            exec({kt_string(sql)})"

    if sqlite:
        imports.add("java.io.File")
    files = [
        kt_file(
            test_path(context, "TestDatabase"),
            context["base"],
            imports.write(),
            [
                (
                    "/** The test database: TEST_DATABASE_URL, or SQLite in a temporary file, created from the table objects before every test. */"
                    if sqlite
                    else f"/** The test database: the {_NAMES.get(database)} database TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the table objects before every test. */"
                ),
                "object TestDatabase {",
                f"    private val TABLES = arrayOf({', '.join(info['tableObject'] for info in tables)})",
                "",
                "    /** The repositories over the test database, with every table dropped and created again. */",
                "    fun open(): SqlUnitOfWork {",
                '        val url = System.getenv("TEST_DATABASE_URL")',
                *(
                    [
                        "        val db =",
                        '            if (url == null) Database.connect("jdbc:sqlite:${File.createTempFile("test", ".db").absolutePath}?foreign_keys=true")',
                        '            else Database.connect(url, user = System.getenv("TEST_DATABASE_USER") ?: "", password = System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
                    ]
                    if sqlite
                    else [
                        "        // The table objects are written for one kind of database: the tests cannot fall back to SQLite",
                        (
                            "        checkNotNull(url) { "
                            + kt_string(
                                f"The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
                            )
                            + " }"
                        ),
                        '        val db = Database.connect(url, user = System.getenv("TEST_DATABASE_USER") ?: "", password = System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
                    ]
                ),
                "        exposedTransaction(db) {",
                *(statement(f'DROP SCHEMA IF EXISTS "{name}" CASCADE') for name in schemas),
                "            SchemaUtils.drop(*TABLES)",
                *(
                    line
                    for item in enums
                    for line in [
                        statement(f'DROP TYPE IF EXISTS "{item["name"]}" CASCADE'),
                        statement(
                            f'CREATE TYPE "{item["name"]}" AS ENUM ({", ".join(quote(item) for item in item["values"])})'
                        ),
                    ]
                ),
                *(statement(f'CREATE SCHEMA "{name}"') for name in schemas),
                "            SchemaUtils.create(*TABLES)",
                "        }",
                "        return SqlUnitOfWork(db)",
                "    }",
                "}",
            ],
        )
    ]
    sql = (
        "SELECT current_database()"
        if database == "postgresql"
        else ("SELECT sqlite_version()" if sqlite else "SELECT DATABASE()")
    )
    files.append(
        kt_file(
            test_path(context, "DatabaseTest"),
            context["base"],
            KtImports(context["base"])
            .add(_EXPOSED_TRANSACTION, "kotlin.test.Test", "kotlin.test.assertEquals", "kotlin.test.assertTrue")
            .write(),
            [
                "/** The tests run on the database they were asked to. */",
                "class DatabaseTest {",
                "    @Test",
                ("    fun isSqlite() {" if sqlite else "    fun isTheOneTestDatabaseUrlNames() {"),
                "        val uow = TestDatabase.open()",
                f"        val value = exposedTransaction(uow.db) {{ exec({kt_string(sql)}) {{ it.next(); it.getString(1) }} }}",
                (
                    '        assertTrue(value!!.startsWith("3."))'
                    if sqlite
                    else '        assertEquals(System.getenv("TEST_DATABASE_URL")!!.substringAfterLast("/").substringBefore("?"), value)'
                ),
                "    }",
                "}",
            ],
        )
    )
    return files


def _transaction(imports: KtImports) -> list[str]:
    imports.add(_EXPOSED_TRANSACTION)
    return [
        "    override fun <T> transaction(work: (UnitOfWork) -> T): T = exposedTransaction(db) { work(this@SqlUnitOfWork) }"
    ]


EXPOSED_ORM = {
    "id": "exposed",
    "holder": {
        "name": "db",
        "type": "Database",
        "ktImport": "org.jetbrains.exposed.v1.jdbc.Database",
        "text": "database",
    },
    "emptyList": lambda *_: '"[]"',
    "databaseFiles": lambda context: [_database_file(context), enum_column_file(context)],
    "entityFiles": lambda context, info: [entity_file(context, info), table_object_file(context, info)],
    "repository": {
        "imports": lambda context, info: [
            qualified(package_of(context, info, "entity"), info["tableObject"]),
            _EXPOSED_TRANSACTION,
        ],
        "doc": lambda context: (
            "through Exposed. Every call joins the transaction of whoever holds the database, when there is one."
            if context["settings"]["transactions"] == "caller"
            else "through Exposed. Every call joins the transaction already open, or is committed at once."
        ),
        "head": lambda *_: [],
        "kept": lambda *_: "db",
        "body": exposed_body,
        "helpers": exposed_helpers,
    },
    "transaction": _transaction,
    "testDatabaseFiles": _test_database_files,
    "openTest": lambda *_: [],
    "closeTest": [],
    "dependencies": lambda context, driver: [
        f'    implementation("org.jetbrains.exposed:exposed-core:{_EXPOSED}")',
        f'    implementation("org.jetbrains.exposed:exposed-jdbc:{_EXPOSED}")',
        f'    implementation("org.jetbrains.exposed:exposed-java-time:{_EXPOSED}")',
        f'    {("implementation" if uses_enum_columns(context) else "runtimeOnly")}("{driver}")',
    ],
    "readme": {
        "intro": f"entities and table objects for Exposed {_EXPOSED}, repositories and services",
        "layout": ["src/main/kotlin/app/AppDatabase.kt      the connection of DATABASE_URL"],
        "entities": "one entity and one table object per table",
        "table": "entity, table object, repositories and service of each table",
    },
}
