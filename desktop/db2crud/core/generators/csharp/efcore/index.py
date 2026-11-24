"""C# + EF Core 9 (Strategy of the C# generator): entities mapped as the database has them in AppDbContext, repositories
over it, a unit of work whose transaction is the context's, and tests on a database EF Core creates from the mapping.
Mirrors web/src/core/generators/csharp/efcore/index.ts."""

from ..context import writes_entities
from ..csharp import CsUsings, cs_string
from ..support import default_connection, file
from ..tests import test_file, tests_ns
from .entities import db_context_file, entity_file, enum_type_name, pg_enums, pg_enums_file
from .repository import ef_body, ef_tail

VERSIONS = {"efCore": "9.0.23", "npgsql": "9.0.4", "pomelo": "9.0.0"}

PROVIDERS = {
    "postgresql": ("Npgsql.EntityFrameworkCore.PostgreSQL", VERSIONS["npgsql"]),
    "mysql": ("Pomelo.EntityFrameworkCore.MySql", VERSIONS["pomelo"]),
    "mariadb": ("Pomelo.EntityFrameworkCore.MySql", VERSIONS["pomelo"]),
    "sqlite": ("Microsoft.EntityFrameworkCore.Sqlite", VERSIONS["efCore"]),
}


def _database_file(context: dict) -> dict:
    """Database: the options of the AppDbContext of the database DATABASE_CONNECTION names."""
    ns = context["base"]
    database = context["settings"]["database"]
    enums = pg_enums(context) if writes_entities(context) else []
    if database == "postgresql" and enums:
        maps = "".join(f".MapEnum<{enum_type_name(context, item)}>({cs_string(item['name'])})" for item in enums)
        use = f"builder.UseNpgsql(connection, npgsql => npgsql{maps})"
    elif database == "postgresql":
        use = "builder.UseNpgsql(connection)"
    elif database == "sqlite":
        use = "builder.UseSqlite(connection)"
    else:
        use = "builder.UseMySql(connection, ServerVersion.AutoDetect(connection))"
    return file(
        ns,
        "Database",
        [
            "/// <summary>The database DATABASE_CONNECTION names (a connection string), through EF Core.</summary>",
            "public static class Database",
            "{",
            f'    public const string DefaultConnection = "{default_connection(context)}";',
            "",
            "    /// <summary>The connection string of DATABASE_CONNECTION, or the default one.</summary>",
            '    public static string Connection => Environment.GetEnvironmentVariable("DATABASE_CONNECTION") ?? DefaultConnection;',
            "",
            "    /// <summary>The options of an AppDbContext over the database at connection.</summary>",
            "    public static DbContextOptions<AppDbContext> Options(string connection)",
            "    {",
            "        var builder = new DbContextOptionsBuilder<AppDbContext>();",
            f"        {use};",
            "        return builder.Options;",
            "    }",
            "",
            "    /// <summary>An AppDbContext over DATABASE_CONNECTION; dispose it when done.</summary>",
            "    public static AppDbContext Open() => new(Options(Connection));",
            "}",
        ],
        CsUsings(ns).add("Microsoft.EntityFrameworkCore"),
    )


NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    usings = CsUsings(tests_ns(context)).add(context["base"])
    if sqlite:
        usings.add("Microsoft.Data.Sqlite", "Microsoft.EntityFrameworkCore")
        doc = "/// <summary>The test database: TEST_DATABASE_CONNECTION, or SQLite in memory, created empty from the mapping for every test.</summary>"
        opening = [
            "        SqliteConnection? memory = null;",
            "        DbContextOptions<AppDbContext> options;",
            "        if (Connection is null)",
            "        {",
            "            // An in-memory database lives as long as its connection is open",
            '            memory = new SqliteConnection("Data Source=:memory:");',
            "            memory.Open();",
            "            options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(memory).Options;",
            "        }",
            "        else options = Database.Options(Connection);",
            "        var db = new AppDbContext(options);",
        ]
    else:
        doc = f"/// <summary>The test database: the {NAMES[database]} database TEST_DATABASE_CONNECTION names, created empty from the mapping for every test.</summary>"
        opening = [
            "        // The mapping is written for one kind of database: the tests cannot fall back to SQLite",
            "        if (Connection is null)",
            f'            throw new InvalidOperationException("The database tests need a disposable {NAMES[database]} database: set TEST_DATABASE_CONNECTION (it is emptied)");',
            "        var db = new AppDbContext(Database.Options(Connection));",
        ]
    return test_file(
        context,
        "TestDatabase",
        usings,
        [
            doc,
            "public sealed class TestDatabase : IAsyncDisposable",
            "{",
            '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
            "",
            sqlite and ["    private readonly SqliteConnection? memory;", ""],
            "    private TestDatabase(AppDbContext db, SqliteConnection? memory)"
            if sqlite
            else "    private TestDatabase(AppDbContext db)",
            "    {",
            "        Db = db;",
            sqlite and "        this.memory = memory;",
            "    }",
            "",
            "    public AppDbContext Db { get; }",
            "",
            "    /// <summary>The test database, with every table dropped and created again.</summary>",
            "    public static async Task<TestDatabase> OpenAsync()",
            "    {",
            *opening,
            "        await db.Database.EnsureDeletedAsync();",
            "        await db.Database.EnsureCreatedAsync();",
            "        return new TestDatabase(db, memory);" if sqlite else "        return new TestDatabase(db);",
            "    }",
            "",
            "    public async ValueTask DisposeAsync()",
            "    {",
            "        await Db.DisposeAsync();",
            sqlite and "        if (memory is not null) await memory.DisposeAsync();",
            "    }",
            "}",
        ],
    )


def _database_tests_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    if database == "postgresql":
        sql = 'SELECT current_database() AS "Value"'
    elif sqlite:
        sql = 'SELECT sqlite_version() AS "Value"'
    else:
        sql = "SELECT DATABASE() AS Value"
    return test_file(
        context,
        "DatabaseTests",
        CsUsings(tests_ns(context)).add("Microsoft.EntityFrameworkCore", "Xunit"),
        [
            "/// <summary>The tests run on the database they were asked to.</summary>",
            "public class DatabaseTests",
            "{",
            "    [Fact]",
            "    public async Task IsSqlite()"
            if sqlite
            else "    public async Task IsTheOneTestDatabaseConnectionNames()",
            "    {",
            "        await using var database = await TestDatabase.OpenAsync();",
            f"        var value = await database.Db.Database.SqlQueryRaw<string>({cs_string(sql)}).SingleAsync();",
            '        Assert.StartsWith("3.", value);'
            if sqlite
            else "        Assert.Equal(database.Db.Database.GetDbConnection().Database, value);",
            "    }",
            "}",
        ],
    )


def _test_members(context: dict) -> list:
    caller = context["settings"]["transactions"] == "caller"
    return [
        "    private TestDatabase database = null!;",
        "",
        "    /// <summary>The repositories over the test database, opened empty for every test</summary>",
        "    private SqlUnitOfWork uow = null!;",
        "",
        "    public async ValueTask InitializeAsync()",
        "    {",
        "        database = await TestDatabase.OpenAsync();",
        caller and "        // The caller owns the transaction: the test opens it, and it ends with the test",
        caller and "        await database.Db.Database.BeginTransactionAsync();",
        "        uow = new SqlUnitOfWork(database.Db);",
        "    }",
        "",
        "    public async ValueTask DisposeAsync() => await database.DisposeAsync();",
    ]


def _doc(context: dict, info: dict) -> str:
    how = (
        "Writes run in the transaction of whoever holds the AppDbContext, when there is one."
        if context["settings"]["transactions"] == "caller"
        else "A write joins the transaction already open, or is committed at once."
    )
    return f"Keeps {info['name']} rows in the database, through AppDbContext. {how}"


EFCORE_ORM = {
    "id": "efcore",
    "holder": "AppDbContext",
    "forget": "uow.Db.ChangeTracker.Clear();",
    "emptyList": lambda context: '"[]"',
    "databaseFiles": lambda context: [db_context_file(context), pg_enums_file(context), _database_file(context)],
    "entityFile": entity_file,
    "repository": {
        "usings": ["Microsoft.EntityFrameworkCore"],
        "doc": _doc,
        "head": lambda context, info: [],
        "body": ef_body,
        "tail": ef_tail,
    },
    "transaction": [
        "// Joins the transaction already open",
        "if (Db.Database.CurrentTransaction is not null) return await work(this);",
        "await using var transaction = await Db.Database.BeginTransactionAsync();",
        "try",
        "{",
        "    var result = await work(this);",
        "    await transaction.CommitAsync();",
        "    return result;",
        "}",
        "catch",
        "{",
        "    await transaction.RollbackAsync();",
        "    Db.ChangeTracker.Clear();",
        "    throw;",
        "}",
    ],
    "testDatabaseFiles": lambda context: [_test_database_file(context), _database_tests_file(context)],
    "testMembers": _test_members,
    "packages": lambda context: [
        ("Microsoft.EntityFrameworkCore.Relational", VERSIONS["efCore"]),
        PROVIDERS.get(context["settings"]["database"], PROVIDERS["postgresql"]),
    ],
    "readme": {
        "intro": "entities mapped with EF Core 9, repositories over `AppDbContext` and services",
        "layout": [
            "src/App/AppDbContext.cs          the mapping of every table, as the database has it",
            "src/App/Database.cs              the options of DATABASE_CONNECTION",
        ],
        "reset": "it is deleted and created again",
    },
}
