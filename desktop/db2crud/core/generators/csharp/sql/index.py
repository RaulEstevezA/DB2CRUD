"""C# without an ORM (Strategy of the C# generator): repositories that write their SQL and run it through ADO.NET over one
connection (sql/database.py holds it and the helpers), plain classes as entities, a unit of work whose transaction is the
connection's, and tests on a real database created from the schema's DDL (SQLite in memory, or the database
TEST_DATABASE_CONNECTION names: the DDL is written for one kind of database). Mirrors
web/src/core/generators/csharp/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ..csharp import CsUsings, cs_string
from ..tests import test_file, tests_ns
from .database import sql_database_files, sql_entity_file
from .repository import sql_body, sql_head, sql_tail

_DRIVERS = {
    "postgresql": ("Npgsql", "10.0.4"),
    "mysql": ("MySqlConnector", "2.6.2"),
    "mariadb": ("MySqlConnector", "2.6.2"),
    "sqlite": ("Microsoft.Data.Sqlite", "10.0.15"),
}

_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    """TestDatabase: a Db on the test database, with every table dropped and created again from the schema's DDL."""
    database = context["settings"]["database"]
    sqlite = database == "sqlite"

    def listed(name: str, doc: str, statements: list[str]) -> list[str]:
        return [
            f"    /// <summary>{doc}</summary>",
            f"    private static readonly string[] {name} =",
            "    [",
            *(f"        {cs_string(statement)}," for statement in statements),
            "    ];",
        ]

    if sqlite:
        doc = "/// <summary>The test database: TEST_DATABASE_CONNECTION, or SQLite in memory, created from the schema before every test.</summary>"
        connection = [
            "    // An in-memory database lives as long as its connection is open",
            '    public static readonly string Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION") ?? "Data Source=:memory:";',
        ]
    else:
        doc = f"/// <summary>The test database: the {_NAMES.get(database)} database TEST_DATABASE_CONNECTION names, created from the schema before every test.</summary>"
        connection = [
            "    // The tables are written for one kind of database: the tests cannot fall back to SQLite",
            '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
        ]
    return test_file(
        context,
        "TestDatabase",
        CsUsings(tests_ns(context)).add(context["base"]),
        [
            doc,
            "internal static class TestDatabase",
            "{",
            *connection,
            "",
            *listed(
                "Drop",
                "Removes every table, so the database starts empty.",
                drop_statements(context["schema"], database),
            ),
            "",
            *listed(
                "Create",
                "Creates every table, in an order the database accepts.",
                create_statements(context["schema"], database),
            ),
            "",
            "    /// <summary>The test database, with every table dropped and created again; on one connection, as MySQL turns its foreign key checks off for the connection that asks.</summary>",
            "    public static async Task<Db> OpenAsync()",
            "    {",
            not sqlite
            and [
                "        if (Connection is null)",
                f'            throw new InvalidOperationException("The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_CONNECTION (it is emptied)");',
            ],
            "        var db = await Database.OpenAsync(Connection);",
            "        foreach (var sql in Drop) await db.RunAsync(sql);",
            "        foreach (var sql in Create) await db.RunAsync(sql);",
            "        return db;",
            "    }",
            "}",
        ],
    )


def _database_tests_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    if database == "postgresql":
        sql = "SELECT current_database()"
    elif sqlite:
        sql = "SELECT sqlite_version()"
    else:
        sql = "SELECT DATABASE()"
    usings = CsUsings(tests_ns(context)).add("Xunit")
    if not sqlite:
        usings.add("System.Data.Common")
    if sqlite:
        checks = ['        Assert.StartsWith("3.", value);']
    else:
        checks = [
            "        var asked = new DbConnectionStringBuilder { ConnectionString = TestDatabase.Connection };",
            '        Assert.Equal(asked["Database"], value);',
        ]
    return test_file(
        context,
        "DatabaseTests",
        usings,
        [
            "/// <summary>The tests run on the database they were asked to.</summary>",
            "public class DatabaseTests",
            "{",
            "    [Fact]",
            "    public async Task IsSqlite()"
            if sqlite
            else "    public async Task IsTheOneTestDatabaseConnectionNames()",
            "    {",
            "        await using var db = await TestDatabase.OpenAsync();",
            f"        var value = await db.OneAsync({cs_string(sql)}, row => row.GetString(0));",
            *checks,
            "    }",
            "}",
        ],
    )


def _test_members(context: dict) -> list:
    """A Db on the test database for every test, and the unit of work over it."""
    caller = context["settings"]["transactions"] == "caller"
    return [
        "    private Db db = null!;",
        "",
        "    /// <summary>The repositories over the test database, opened empty for every test</summary>",
        "    private SqlUnitOfWork uow = null!;",
        "",
        "    public async ValueTask InitializeAsync()",
        "    {",
        "        db = await TestDatabase.OpenAsync();",
        caller and "        // The caller owns the transaction: the test opens it, and it ends with the test",
        caller and "        await db.BeginAsync();",
        "        uow = new SqlUnitOfWork(db);",
        "    }",
        "",
        "    public async ValueTask DisposeAsync() => await db.DisposeAsync();",
    ]


def _doc(context: dict, info: dict) -> str:
    how = (
        "Writes run in the transaction of whoever holds the Db, when there is one."
        if context["settings"]["transactions"] == "caller"
        else "A write joins the transaction already open, or is committed at once."
    )
    return f"Keeps {info['name']} rows in the database, with SQL through ADO.NET. {how}"


SQL_ORM = {
    "id": "sql",
    "holder": "Db",
    # Nothing is kept between reads
    "forget": None,
    "emptyList": lambda context: '"{}"' if context["settings"]["database"] == "postgresql" else '"[]"',
    "databaseFiles": sql_database_files,
    "entityFile": sql_entity_file,
    "repository": {"usings": [], "doc": _doc, "head": sql_head, "body": sql_body, "tail": sql_tail},
    "transaction": [
        "// Joins the transaction already open",
        "if (Db.InTransaction) return await work(this);",
        "await Db.BeginAsync();",
        "try",
        "{",
        "    var result = await work(this);",
        "    await Db.CommitAsync();",
        "    return result;",
        "}",
        "catch",
        "{",
        "    await Db.RollbackAsync();",
        "    throw;",
        "}",
    ],
    "testDatabaseFiles": lambda context: [_test_database_file(context), _database_tests_file(context)],
    "testMembers": _test_members,
    # The ADO.NET driver of the database is all it needs
    "packages": lambda context: [_DRIVERS.get(context["settings"]["database"], _DRIVERS["postgresql"])],
    "readme": {
        "intro": "plain entities, repositories with their own SQL through ADO.NET and services",
        "layout": [
            "src/App/Database.cs              opens the database DATABASE_CONNECTION names",
            "src/App/Db.cs                    one connection and its transaction, and how the repositories run SQL on it",
        ],
        "reset": "its tables are dropped and created again",
    },
}
