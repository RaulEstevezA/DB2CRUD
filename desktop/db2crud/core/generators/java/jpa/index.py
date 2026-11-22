"""Java 21 + JPA (Hibernate 7) (Strategy of the Java generator): entities that reflect the database, repositories over an
EntityManager, a unit of work whose transaction is the EntityManager's, and tests on a database Hibernate creates from the
entities. Mirrors web/src/core/generators/java/jpa/index.ts."""

from ...types import lines
from ..context import package_of, repository_type, sql_repository_class
from ..java import JavaImports, java_path, java_string
from ..project import VERSIONS, dependency
from ..support import file
from .entities import entity_file, enum_types
from .repository import jpa_body, jpa_head, jpa_tail

URLS = {
    "postgresql": "jdbc:postgresql://localhost:5432/app",
    "mysql": "jdbc:mysql://localhost:3306/app",
    "mariadb": "jdbc:mariadb://localhost:3306/app",
    "sqlite": "jdbc:sqlite:app.db?foreign_keys=true",
}


def database_file(context: dict) -> dict:
    """Database: the EntityManagerFactory of the database DATABASE_URL names, with every entity."""
    pkg = context["base"]
    imports = JavaImports(pkg).add(
        "jakarta.persistence.EntityManagerFactory", "org.hibernate.jpa.HibernatePersistenceConfiguration"
    )
    for info in context["tables"]:
        imports.add(f"{package_of(context, info, 'entity')}.{info['entity']}")
    url = URLS.get(context["settings"]["database"])
    entities = ", ".join(f"{info['entity']}.class" for info in context["tables"])
    return file(
        pkg,
        "Database",
        [
            "/** The database DATABASE_URL names (a JDBC URL; DATABASE_USER and DATABASE_PASSWORD), through Hibernate. */",
            "public final class Database {",
            f'    public static final String DEFAULT_URL = "{url}";',
            "",
            "    private Database() {}",
            "",
            "    /** Every entity, so Hibernate knows every table */",
            f"    public static final List<Class<?>> ENTITIES = List.of({entities});",
            "",
            "    /** The configuration of the database at url: give it a connection pool or a DataSource for production. */",
            "    public static HibernatePersistenceConfiguration configuration(String url, String user, String password) {",
            '        HibernatePersistenceConfiguration configuration = new HibernatePersistenceConfiguration("app")',
            "                .managedClasses(ENTITIES)",
            "                .jdbcUrl(url)",
            "                // The services check the values; the database fills its defaults",
            '                .property("hibernate.check_nullability", false)',
            "                // Every name is quoted, so names like rank or order work and are used exactly as the database has them",
            '                .property("hibernate.globally_quoted_identifiers", true)',
            '                .property("hibernate.globally_quoted_identifiers_skip_column_definitions", true);',
            '        if (user != null) configuration.jdbcCredentials(user, password == null ? "" : password);',
            "        return configuration;",
            "    }",
            "",
            "    /** The EntityManagerFactory of DATABASE_URL, DATABASE_USER and DATABASE_PASSWORD. */",
            "    public static EntityManagerFactory open() {",
            '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
            '        return configuration(url, System.getenv("DATABASE_USER"), System.getenv("DATABASE_PASSWORD")).createEntityManagerFactory();',
            "    }",
            "}",
        ],
        imports.add("java.util.List"),
    )


def _unit_of_work(context: dict, imports: JavaImports, accessors: list[str]) -> list[str]:
    """The class SqlUnitOfWork: the repositories over one EntityManager, and its transaction."""
    settings = context["settings"]
    tables = context["tables"]
    operation = settings["transactions"] == "operation"
    if operation:
        transaction = [
            "        EntityTransaction transaction = entityManager.getTransaction();",
            "        // Joins the transaction already open",
            "        if (transaction.isActive()) return work.apply(this);",
            "        transaction.begin();",
            "        try {",
            "            T result = work.apply(this);",
            "            transaction.commit();",
            "            return result;",
            "        } catch (RuntimeException error) {",
            "            if (transaction.isActive()) transaction.rollback();",
            "            throw error;",
            "        }",
        ]
    else:
        transaction = ["        return work.apply(this);"]
    imports.add("jakarta.persistence.EntityManager")
    if operation:
        imports.add("jakarta.persistence.EntityTransaction")
    return [
        "/** The repositories over one EntityManager, and its transaction. */",
        "public class SqlUnitOfWork implements UnitOfWork {",
        "    private final EntityManager entityManager;",
        *(f"    private final {repository_type(context, info)} {info['attr']};" for info in tables),
        "",
        "    public SqlUnitOfWork(EntityManager entityManager) {",
        "        this.entityManager = entityManager;",
        *(f"        this.{info['attr']} = new {sql_repository_class(info)}(entityManager);" for info in tables),
        "    }",
        "",
        "    public EntityManager entityManager() {",
        "        return entityManager;",
        "    }",
        *accessors,
        "",
        "    @Override",
        "    public <T> T transaction(Function<UnitOfWork, T> work) {",
        *transaction,
        "    }",
        "}",
    ]


NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    pkg = context["base"]
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    types = enum_types(context)
    imports = JavaImports(pkg).add("jakarta.persistence.EntityManager", "jakarta.persistence.EntityManagerFactory")
    if types:
        imports.add("java.sql.Connection", "java.sql.DriverManager", "java.sql.SQLException", "java.sql.Statement")
    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in a file of target/, created from the entities before every test. */"
        url = '    static final String URL = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:sqlite:target/test.db?foreign_keys=true");'
    else:
        doc = "/** The test database: the one TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the entities before every test. */"
        url = [
            "    // The entities are written for one kind of database: the tests cannot fall back to SQLite",
            '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        ]
    statements = [
        f"            statement.execute({java_string(f'DO $$ BEGIN {sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $$')});"
        for sql in types
    ]
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        doc,
        "final class TestDatabase {",
        url,
        '    static final String USER = System.getenv("TEST_DATABASE_USER");',
        '    static final String PASSWORD = System.getenv("TEST_DATABASE_PASSWORD");',
        "",
        "    private static EntityManagerFactory factory;",
        "",
        "    private TestDatabase() {}",
        "",
        "    /** An EntityManager over the test database, with every table dropped and created again from the entities. */",
        "    static synchronized EntityManager open() {",
        not sqlite
        and [
            "        if (URL == null)",
            f'            throw new IllegalStateException("The database tests need a disposable {NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)");',
        ],
        "        if (factory == null) {",
        bool(types) and "            createTypes();",
        "            factory = Database.configuration(URL, USER, PASSWORD).createEntityManagerFactory();",
        "        }",
        "        factory.getSchemaManager().drop(true);",
        "        factory.getSchemaManager().create(true);",
        "        return factory.createEntityManager();",
        "    }",
        bool(types)
        and [
            "",
            "    /** The enum types of the database the entities use, which Hibernate does not create. */",
            "    private static void createTypes() {",
            "        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD); Statement statement = connection.createStatement()) {",
            *statements,
            "        } catch (SQLException error) {",
            "            throw new IllegalStateException(error);",
            "        }",
            "    }",
        ],
        "}",
        "",
    )
    return {"path": java_path(pkg, "TestDatabase", True), "content": content}


def _database_test_file(context: dict) -> dict:
    pkg = context["base"]
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    if database == "postgresql":
        sql = "SELECT current_database()"
    elif sqlite:
        sql = "SELECT sqlite_version()"
    else:
        sql = "SELECT DATABASE()"
    content = lines(
        f"package {pkg};",
        "",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        sqlite and "import static org.junit.jupiter.api.Assertions.assertTrue;",
        "",
        "import jakarta.persistence.EntityManager;",
        not sqlite and "import java.net.URI;",
        "import org.junit.jupiter.api.Test;",
        "",
        "/** The tests run on the database they were asked to. */",
        "class DatabaseTest {",
        "    @Test",
        "    void isSqlite() {" if sqlite else "    void isTheOneTestDatabaseUrlNames() {",
        "        EntityManager entityManager = TestDatabase.open();",
        f"        Object result = entityManager.createNativeQuery({java_string(sql)}).getSingleResult();",
        "        entityManager.close();",
        '        assertTrue(String.valueOf(result).startsWith("3."));'
        if sqlite
        else '        assertEquals(URI.create(TestDatabase.URL.substring("jdbc:".length())).getPath().substring(1), String.valueOf(result));',
        "    }",
        "}",
        "",
    )
    return {"path": java_path(pkg, "DatabaseTest", True), "content": content}


def _test_session(context: dict, imports: JavaImports) -> list:
    """An EntityManager over the test database for every test, and the unit of work over it."""
    imports.add(
        "jakarta.persistence.EntityManager", "org.junit.jupiter.api.AfterEach", "org.junit.jupiter.api.BeforeEach"
    )
    caller = context["settings"]["transactions"] == "caller"
    return [
        "    private EntityManager entityManager;",
        "    /** The repositories over the test database, opened empty for every test */",
        "    private SqlUnitOfWork uow;",
        "",
        "    @BeforeEach",
        "    void open() {",
        "        entityManager = TestDatabase.open();",
        caller and "        // The caller owns the transaction: the test opens it, and rolls it back at the end",
        caller and "        entityManager.getTransaction().begin();",
        "        uow = new SqlUnitOfWork(entityManager);",
        "    }",
        "",
        "    @AfterEach",
        "    void close() {",
        "        if (entityManager.getTransaction().isActive()) entityManager.getTransaction().rollback();",
        "        entityManager.close();",
        "    }",
    ]


def _dependencies(context: dict) -> list:
    """Hibernate (with the dialects of SQLite) and, for JSON columns, Jackson."""
    uses_json = any(
        column["column"]["type"]["kind"] in ("json", "array")
        for info in context["tables"]
        for column in info["columns"]
    )
    return [
        *dependency("org.hibernate.orm", "hibernate-core", VERSIONS["hibernate"]),
        context["settings"]["database"] == "sqlite"
        and dependency("org.hibernate.orm", "hibernate-community-dialects", VERSIONS["hibernate"]),
        # Hibernate reads and writes JSON columns with Jackson
        uses_json and dependency("com.fasterxml.jackson.core", "jackson-databind", VERSIONS["jackson"]),
    ]


def _doc(context: dict, info: dict) -> str:
    how = (
        "It never commits: writes run in the transaction of whoever holds the EntityManager."
        if context["settings"]["transactions"] == "caller"
        else "A write joins the transaction already open, or commits at once."
    )
    return f"Keeps {info['name']} rows in the database, through an EntityManager. {how}"


JPA_ORM = {
    "id": "jpa",
    "holder": "EntityManager",
    "databaseFiles": lambda context: [database_file(context)],
    "entityFile": entity_file,
    "repository": {"doc": _doc, "head": jpa_head, "body": jpa_body, "tail": jpa_tail},
    "unitOfWork": _unit_of_work,
    "testDatabaseFiles": lambda context: [_test_database_file(context), _database_test_file(context)],
    "testSession": _test_session,
    "dependencies": _dependencies,
    "readme": {
        "intro": "JPA entities, repositories over an `EntityManager` (Hibernate) and services",
        "layout": lambda context: [
            f"src/main/java/{context['base']}/Database.java        the EntityManagerFactory of DATABASE_URL, with every entity"
        ],
        "note": "`Database.open()` uses the connection pool built into Hibernate, which is fine for trying the code; in production give `Database.configuration(...)` a `DataSource` or a pool such as HikariCP.",
    },
}
