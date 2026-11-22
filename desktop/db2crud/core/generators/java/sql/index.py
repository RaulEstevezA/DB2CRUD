"""Java 21 without an ORM (Strategy of the Java generator): repositories that write their SQL and run it through JDBC over
one Connection (sql/database.py holds the connection and the helpers), plain classes as entities, a unit of work whose
transaction is the connection's, and tests on a real database created from the schema's DDL (SQLite in a file of target/,
or the database TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors
web/src/core/generators/java/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ...types import lines
from ..context import repository_type, sql_repository_class
from ..java import JavaImports, java_path, java_string
from .database import sql_database_files, sql_entity_file
from .repository import sql_body, sql_head, sql_tail

_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _unit_of_work(context: dict, imports: JavaImports, accessors: list[str]) -> list[str]:
    """The class SqlUnitOfWork: the repositories over one connection, and its transaction."""
    operation = context["settings"]["transactions"] == "operation"
    imports.add("java.sql.Connection")
    if operation:
        imports.add("java.sql.SQLException")
    tables = context["tables"]
    if operation:
        transaction = [
            "        try {",
            "            // Joins the transaction already open",
            "            if (!connection.getAutoCommit()) return work.apply(this);",
            "            connection.setAutoCommit(false);",
            "            try {",
            "                T result = work.apply(this);",
            "                connection.commit();",
            "                return result;",
            "            } catch (RuntimeException error) {",
            "                connection.rollback();",
            "                throw error;",
            "            } finally {",
            "                connection.setAutoCommit(true);",
            "            }",
            "        } catch (SQLException error) {",
            "            throw Sql.failure(error);",
            "        }",
        ]
    else:
        transaction = ["        return work.apply(this);"]
    return [
        "/** The repositories over one JDBC connection, and its transaction. */",
        "public class SqlUnitOfWork implements UnitOfWork {",
        "    private final Connection connection;",
        *(f"    private final {repository_type(context, info)} {info['attr']};" for info in tables),
        "",
        "    public SqlUnitOfWork(Connection connection) {",
        "        this.connection = connection;",
        *(f"        this.{info['attr']} = new {sql_repository_class(info)}(connection);" for info in tables),
        "    }",
        "",
        "    public Connection connection() {",
        "        return connection;",
        "    }",
        *accessors,
        "",
        "    @Override",
        "    public <T> T transaction(Function<UnitOfWork, T> work) {",
        *transaction,
        "    }",
        "}",
    ]


def _test_database_file(context: dict) -> dict:
    """TestDatabase: a connection to the test database, with every table dropped and created again from the DDL."""
    database = context["settings"]["database"]
    sqlite = database == "sqlite"

    def listed(name: str, doc: str, statements: list[str]) -> list[str]:
        last = len(statements) - 1
        return [
            f"    /** {doc} */",
            f"    static final List<String> {name} = List.of(",
            *(f"            {java_string(item)}{',' if index < last else ''}" for index, item in enumerate(statements)),
            "    );",
        ]

    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in a file of target/, created from the schema before every test. */"
        url = '    static final String URL = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:sqlite:target/test.db?foreign_keys=true");'
    else:
        doc = "/** The test database: the one TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the schema before every test. */"
        url = [
            "    // The tables are written for one kind of database: the tests cannot fall back to SQLite",
            '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        ]
    content = lines(
        f"package {context['base']};",
        "",
        "import java.sql.Connection;",
        "import java.sql.SQLException;",
        "import java.sql.Statement;",
        "import java.util.List;",
        "",
        doc,
        "final class TestDatabase {",
        url,
        '    static final String USER = System.getenv("TEST_DATABASE_USER");',
        '    static final String PASSWORD = System.getenv("TEST_DATABASE_PASSWORD");',
        "",
        *listed(
            "DROP", "Removes every table, so the database starts empty.", drop_statements(context["schema"], database)
        ),
        "",
        *listed(
            "CREATE",
            "Creates every table, in an order the database accepts.",
            create_statements(context["schema"], database),
        ),
        "",
        "    private TestDatabase() {}",
        "",
        "    /** A connection to the test database, with every table dropped and created again; on that one connection, as MySQL turns its foreign key checks off for the connection that asks. */",
        "    static Connection open() throws SQLException {",
        not sqlite
        and [
            "        if (URL == null)",
            f'            throw new IllegalStateException("The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)");',
        ],
        "        Connection connection = Database.connect(URL, USER, PASSWORD);",
        "        try (Statement statement = connection.createStatement()) {",
        "            for (String sql : DROP) statement.execute(sql);",
        "            for (String sql : CREATE) statement.execute(sql);",
        "        }",
        "        return connection;",
        "    }",
        "}",
        "",
    )
    return {"path": java_path(context["base"], "TestDatabase", True), "content": content}


def _database_test_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    if database == "postgresql":
        query = "SELECT current_database()"
    elif sqlite:
        query = "SELECT sqlite_version()"
    else:
        query = "SELECT DATABASE()"
    content = lines(
        f"package {context['base']};",
        "",
        "import static org.junit.jupiter.api.Assertions.assertTrue;"
        if sqlite
        else "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "",
        not sqlite and "import java.net.URI;",
        "import java.sql.Connection;",
        "import java.sql.ResultSet;",
        "import java.sql.SQLException;",
        "import java.sql.Statement;",
        "import org.junit.jupiter.api.Test;",
        "",
        "/** The tests run on the database they were asked to. */",
        "class DatabaseTest {",
        "    @Test",
        "    void isSqlite() throws SQLException {"
        if sqlite
        else "    void isTheOneTestDatabaseUrlNames() throws SQLException {",
        f"        try (Connection connection = TestDatabase.open(); Statement statement = connection.createStatement(); ResultSet result = statement.executeQuery({java_string(query)})) {{",
        "            result.next();",
        '            assertTrue(result.getString(1).startsWith("3."));'
        if sqlite
        else '            assertEquals(URI.create(TestDatabase.URL.substring("jdbc:".length())).getPath().substring(1), result.getString(1));',
        "        }",
        "    }",
        "}",
        "",
    )
    return {"path": java_path(context["base"], "DatabaseTest", True), "content": content}


def _test_session(context: dict, imports: JavaImports) -> list:
    """A connection to the test database for every test, and the unit of work over it."""
    imports.add(
        "java.sql.Connection",
        "java.sql.SQLException",
        "org.junit.jupiter.api.AfterEach",
        "org.junit.jupiter.api.BeforeEach",
    )
    caller = context["settings"]["transactions"] == "caller"
    return [
        "    private Connection connection;",
        "    /** The repositories over the test database, opened empty for every test */",
        "    private SqlUnitOfWork uow;",
        "",
        "    @BeforeEach",
        "    void open() throws SQLException {",
        "        connection = TestDatabase.open();",
        caller and "        // The caller owns the transaction: the test opens it, and rolls it back at the end",
        caller and "        connection.setAutoCommit(false);",
        "        uow = new SqlUnitOfWork(connection);",
        "    }",
        "",
        "    @AfterEach",
        "    void close() throws SQLException {",
        "        if (!connection.getAutoCommit()) connection.rollback();",
        "        connection.close();",
        "    }",
    ]


def _doc(context: dict, info: dict) -> str:
    if context["settings"]["transactions"] == "repository":
        how = "Every write is committed at once."
    else:
        how = "It never commits: the transaction belongs to whoever holds the connection."
    return f"Keeps {info['name']} rows in the database, with SQL through JDBC. {how}"


SQL_ORM = {
    "id": "sql",
    "holder": "Connection",
    # Nothing is kept between reads
    "forget": None,
    "databaseFiles": sql_database_files,
    "entityFile": sql_entity_file,
    "repository": {"doc": _doc, "head": sql_head, "body": sql_body, "tail": sql_tail},
    "unitOfWork": _unit_of_work,
    "testDatabaseFiles": lambda context: [_test_database_file(context), _database_test_file(context)],
    "testSession": _test_session,
    # The JDBC driver of the database is all it needs
    "dependencies": lambda context: [],
    "readme": {
        "intro": "plain entities, repositories with their own SQL over a JDBC `Connection`, and services",
        "layout": lambda context: [
            f"src/main/java/{context['base']}/Database.java        the JDBC connection to DATABASE_URL",
            f"src/main/java/{context['base']}/Sql.java             how the repositories run SQL: values, rows and refusals",
        ],
        "note": "`Database.open()` opens one connection, which is fine for trying the code; in production give the unit of work connections from a pool such as HikariCP.",
    },
}
