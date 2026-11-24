"""* PHP without an ORM (Strategy of common/orm.ts): repositories that write their SQL and run it through PDO (sql/database.ts
holds the connection and the helpers), plain classes as entities, a unit of work whose transaction is the connection's, and
tests on a real database created from the schema's DDL (SQLite in memory, or the database TEST_DATABASE_URL names: the DDL
is written for one kind of database). Mirrors
web/src/core/generators/php/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ..common.context import class_name, namespace_of, sql_repository_class
from ..common.php import PhpUses, field_name, php_string
from ..common.support import repository_assignments, repository_properties
from ..common.tests import TESTS_NS, test_file
from .database import default_url, sql_database_files, sql_entity_file, sql_php_type
from .repository import sql_body, sql_helpers, sql_init

_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}

_EXTENSIONS = {"postgresql": "pdo_pgsql", "mysql": "pdo_mysql", "mariadb": "pdo_mysql", "sqlite": "pdo_sqlite"}


def _unit_of_work(context: dict, uses: PhpUses) -> list:
    uses.add("PDO")
    properties = repository_properties(context, uses, lambda info: info["attr"])
    for info in context["tables"]:
        uses.add(class_name(namespace_of(context, info, "repository"), sql_repository_class(info)))
    operation = context["settings"]["transactions"] == "operation"
    return [
        "/** The repositories over one PDO connection, and its transaction. */",
        "final class SqlUnitOfWork implements UnitOfWork",
        "{",
        *(f"    {line}" for line in properties),
        "",
        "    public function __construct(public readonly PDO $db)",
        "    {",
        *(
            f"        {line}"
            for line in repository_assignments(context, lambda info: f"new {sql_repository_class(info)}($db)")
        ),
        "    }",
        "",
        "    public function transaction(callable $work): mixed",
        "    {",
        *(
            [
                "        // Joins the transaction already open",
                "        if ($this->db->inTransaction()) {",
                "            return $work($this);",
                "        }",
                "        $this->db->beginTransaction();",
                "        try {",
                "            $result = $work($this);",
                "            $this->db->commit();",
                "            return $result;",
                "        } catch (\\Throwable $error) {",
                "            if ($this->db->inTransaction()) {",
                "                $this->db->rollBack();",
                "            }",
                "            throw $error;",
                "        }",
            ]
            if operation
            else ["        return $work($this);"]
        ),
        "    }",
        "}",
    ]


def _test_database_file(context: dict) -> dict:
    """TestDatabase: the test database, with every table dropped and created again from the schema's DDL."""
    database = context["settings"]["database"]
    sqlite = database == "sqlite"

    def list_(name: str, doc: str, statements: list[str]):
        return [
            f"    /** {doc} */",
            f"    private const {name} = [",
            *(f"        {php_string(statement)}," for statement in statements),
            "    ];",
            "",
        ]

    missing = php_string(
        f"The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
    )
    return test_file(
        "TestDatabase",
        PhpUses(TESTS_NS).add(f"{context['base']}\\Database", f"{context['base']}\\SqlUnitOfWork"),
        [
            (
                "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created from the schema before every test. */"
                if sqlite
                else f"/** The test database: the {_NAMES.get(database)} database TEST_DATABASE_URL names, created from the schema before every test. */"
            ),
            "final class TestDatabase",
            "{",
            *(
                list_(
                    "DROP",
                    "Removes every table, so the database starts empty",
                    drop_statements(context["schema"], database),
                )
            ),
            *(
                list_(
                    "CREATE",
                    "Creates every table, in an order the database accepts",
                    create_statements(context["schema"], database),
                )
            ),
            "    public static function url(): ?string",
            "    {",
            "        $url = getenv('TEST_DATABASE_URL');",
            "        return is_string($url) && $url !== '' ? $url : null;",
            "    }",
            "",
            "    /** The repositories over the test database, with every table dropped and created again. */",
            "    public static function open(): SqlUnitOfWork",
            "    {",
            *(
                ["        $db = Database::open(self::url() ?? 'sqlite:///:memory:');"]
                if sqlite
                else [
                    "        // The tables are written for one kind of database: the tests cannot fall back to SQLite",
                    f"        $db = Database::open(self::url() ?? throw new \\RuntimeException({missing}));",
                ]
            ),
            "        foreach ([...self::DROP, ...self::CREATE] as $sql) {",
            "            $db->exec($sql);",
            "        }",
            "        return new SqlUnitOfWork($db);",
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
    return test_file(
        "DatabaseTest",
        PhpUses(TESTS_NS).add(f"{context['base']}\\Sql", "PHPUnit\\Framework\\TestCase"),
        [
            "/** The tests run on the database they were asked to. */",
            "final class DatabaseTest extends TestCase",
            "{",
            (
                "    public function testIsSqlite(): void"
                if sqlite
                else "    public function testIsTheOneTestDatabaseUrlNames(): void"
            ),
            "    {",
            f"        $name = Sql::one(TestDatabase::open()->db, {php_string(sql)})[0];",
            (
                "        self::assertStringStartsWith('3.', $name);"
                if sqlite
                else "        self::assertSame(ltrim((string) parse_url((string) TestDatabase::url(), PHP_URL_PATH), '/'), $name);"
            ),
            "    }",
            "}",
        ],
    )


SQL_ORM = {
    "id": "sql",
    "label": "SQL (PDO)",
    "intro": "plain entities, repositories with their own SQL through PDO and services",
    "property": lambda column: field_name(column["name"]),
    "phpType": sql_php_type,
    "entityFile": sql_entity_file,
    "databaseFiles": sql_database_files,
    "repository": {
        "doc": lambda *_: "with SQL through PDO.",
        "init": sql_init,
        "body": sql_body,
        "helpers": sql_helpers,
    },
    "unitOfWork": _unit_of_work,
    "forget": lambda *_: None,
    "begin": lambda uow: f"{uow}->db->beginTransaction()",
    "close": lambda uow: f"unset({uow})",
    "testDatabase": lambda context: [_test_database_file(context), _database_test_file(context)],
    "require": lambda context: {f"ext-{_EXTENSIONS.get(context['settings']['database'], 'pdo_pgsql')}": "*"},
    "defaultUrl": default_url,
    "layout": lambda *_: [
        "src/Database.php             the PDO connection to DATABASE_URL",
        "src/Sql.php                  how the repositories run SQL: values and refusals",
    ],
}
