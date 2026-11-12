"""What every C# project shares: the domain errors services throw (no HTTP codes), the pages lists are read in, Patch
(a field of an update: absent, null or a value), the unit of work over the repositories, and the options of the
database DATABASE_CONNECTION names. Mirrors web/src/core/generators/csharp/support.ts."""

from ..types import lines
from .context import (
    common_namespace,
    errors_namespace,
    memory_repository_class,
    namespace_of,
    path_of,
    repository_type,
    sql_repository_class,
    writes_entities,
)
from .csharp import CsUsings, cs_string
from .entities import enum_type_name, pg_enums

DOMAINEXCEPTION = [
    "/// <summary>Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them.</summary>",
    "public abstract class DomainException(string message) : Exception(message);",
]

NOTFOUNDEXCEPTION = [
    "/// <summary>No row has this key.</summary>",
    'public class NotFoundException(string entity, object key) : DomainException($"No {entity} has the key {key}")',
    "{",
    "    public string Entity { get; } = entity;",
    "    public object Key { get; } = key;",
    "}",
]

CONFLICTEXCEPTION = [
    "/// <summary>The change clashes with what is stored: a unique value, a newer version, rows that depend on it.</summary>",
    'public class ConflictException(string entity, string reason, IReadOnlyList<string>? fields = null) : DomainException($"{entity}: {reason}")',
    "{",
    "    public string Entity { get; } = entity;",
    "    public string Reason { get; } = reason;",
    "    public IReadOnlyList<string> Fields { get; } = fields ?? [];",
    "}",
]

FIELDERROR = [
    "/// <summary>What is wrong with one field.</summary>",
    "public record FieldError(string Field, string Message);",
]

VALIDATIONFAILEDEXCEPTION = [
    "/// <summary>The values break the rules of the table: missing, too long, out of range, pointing nowhere.</summary>",
    "public class ValidationFailedException(string entity, IReadOnlyList<FieldError> errors)",
    '    : DomainException($"{entity}: {string.Join("; ", errors.Select(error => $"{error.Field}: {error.Message}"))}")',
    "{",
    "    public string Entity { get; } = entity;",
    "    public IReadOnlyList<FieldError> Errors { get; } = errors;",
    "}",
]

PAGE = [
    "/// <summary>A page of a list: the rows from an offset, and how many there are in all.</summary>",
    "public record Page<T>(IReadOnlyList<T> Items, long Total, int Offset, int Limit)",
    "{",
    "    /// <summary>The same page with every row turned into something else.</summary>",
    "    public Page<TResult> Map<TResult>(Func<T, TResult> mapper) => new(Items.Select(mapper).ToList(), Total, Offset, Limit);",
    "}",
]

CURSORPAGE = [
    "/// <summary>A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page).</summary>",
    "public record CursorPage<T>(IReadOnlyList<T> Items, IReadOnlyList<object>? Next)",
    "{",
    "    /// <summary>The same page with every row turned into something else.</summary>",
    "    public CursorPage<TResult> Map<TResult>(Func<T, TResult> mapper) => new(Items.Select(mapper).ToList(), Next);",
    "}",
]

PATCH = [
    "/// <summary>A field of an update: absent (it keeps its value), or present with a value, which may be null.</summary>",
    "public sealed class Patch<T>",
    "{",
    "    private Patch(bool isPresent, T? value)",
    "    {",
    "        IsPresent = isPresent;",
    "        Value = value;",
    "    }",
    "",
    "    /// <summary>The field keeps its value.</summary>",
    "    public static Patch<T> Absent { get; } = new(false, default);",
    "",
    "    /// <summary>The field takes this value, which may be null.</summary>",
    "    public static Patch<T> Of(T? value) => new(true, value);",
    "",
    "    public bool IsPresent { get; }",
    "",
    "    /// <summary>The value to set; default when absent.</summary>",
    "    public T? Value { get; }",
    "",
    '    public override string ToString() => IsPresent ? $"Patch[{Value}]" : "Patch.Absent";',
    "}",
]


def _file(ns: str, name: str, body: list, usings: CsUsings | None = None) -> dict:
    written = usings.write() if usings else ""
    return {
        "path": path_of(ns, name),
        "content": lines(written != "" and [written, ""], f"namespace {ns};", "", *body, ""),
    }


def error_files(context: dict) -> list[dict]:
    ns = errors_namespace(context)
    return [
        _file(ns, "DomainException", DOMAINEXCEPTION),
        _file(ns, "NotFoundException", NOTFOUNDEXCEPTION),
        _file(ns, "ConflictException", CONFLICTEXCEPTION),
        _file(ns, "FieldError", FIELDERROR),
        _file(ns, "ValidationFailedException", VALIDATIONFAILEDEXCEPTION),
    ]


def common_files(context: dict) -> list[dict]:
    ns = common_namespace(context)
    settings = context["settings"]
    files = []
    if settings["paging"] == "offset":
        files.append(_file(ns, "Page", PAGE))
    if settings["paging"] == "cursor":
        files.append(_file(ns, "CursorPage", CURSORPAGE))
    if settings["services"] and settings["updates"] == "patch":
        files.append(_file(ns, "Patch", PATCH))
    return files


HOW = {
    "operation": "Each service operation runs in TransactionAsync: committed when it ends, rolled back when it fails.",
    "caller": "Services never commit: whoever holds the AppDbContext opens and ends its transaction; TransactionAsync only groups the code.",
    "repository": "Every repository write is committed at once; TransactionAsync only groups the code.",
}

VOID_TRANSACTION = [
    "",
    "    public Task TransactionAsync(Func<IUnitOfWork, Task> work) =>",
    "        TransactionAsync<bool>(async uow =>",
    "        {",
    "            await work(uow);",
    "            return true;",
    "        });",
]


def unit_of_work_files(context: dict) -> list[dict]:
    """IUnitOfWork, SqlUnitOfWork and MemoryUnitOfWork, in the root namespace."""
    ns = context["base"]
    settings = context["settings"]
    tables = context["tables"]

    def repositories() -> CsUsings:
        usings = CsUsings(ns)
        for info in tables:
            usings.add(namespace_of(context, info, "repository"))
        return usings

    def properties(value) -> list[str]:
        return [
            f"    public {repository_type(context, info)} {info['attr']} {{ get; }} = {value(info)};" for info in tables
        ]

    if settings["transactions"] == "operation":
        transaction = [
            "        // Joins the transaction already open",
            "        if (Db.Database.CurrentTransaction is not null) return await work(this);",
            "        await using var transaction = await Db.Database.BeginTransactionAsync();",
            "        try",
            "        {",
            "            var result = await work(this);",
            "            await transaction.CommitAsync();",
            "            return result;",
            "        }",
            "        catch",
            "        {",
            "            await transaction.RollbackAsync();",
            "            Db.ChangeTracker.Clear();",
            "            throw;",
            "        }",
        ]
    else:
        transaction = ["        return await work(this);"]
    files = [
        _file(
            ns,
            "IUnitOfWork",
            [
                f"/// <summary>What services depend on: a repository per table and a transaction. {HOW[settings['transactions']]}</summary>",
                "public interface IUnitOfWork",
                "{",
                *(f"    {repository_type(context, info)} {info['attr']} {{ get; }}" for info in tables),
                "",
                "    /// <summary>Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws.</summary>",
                "    Task<T> TransactionAsync<T>(Func<IUnitOfWork, Task<T>> work);",
                "",
                "    /// <summary>Runs work that returns nothing, in the same way.</summary>",
                "    Task TransactionAsync(Func<IUnitOfWork, Task> work);",
                "}",
            ],
            repositories(),
        ),
        _file(
            ns,
            "SqlUnitOfWork",
            [
                "/// <summary>The repositories over one AppDbContext, and its transaction.</summary>",
                "public class SqlUnitOfWork(AppDbContext db) : IUnitOfWork",
                "{",
                "    public AppDbContext Db { get; } = db;",
                *properties(lambda info: f"new {sql_repository_class(info)}(db)"),
                "",
                "    public async Task<T> TransactionAsync<T>(Func<IUnitOfWork, Task<T>> work)",
                "    {",
                *transaction,
                "    }",
                *VOID_TRANSACTION,
                "}",
            ],
            repositories(),
        ),
    ]
    if settings["memoryRepositories"]:
        files.append(
            _file(
                ns,
                "MemoryUnitOfWork",
                [
                    "/// <summary>The in-memory repositories, for tests and for trying the services without a database.</summary>",
                    "public class MemoryUnitOfWork : IUnitOfWork",
                    "{",
                    *properties(lambda info: f"new {memory_repository_class(info)}()"),
                    "",
                    "    /// <summary>Memory has no transactions: changes are kept as they are made.</summary>",
                    "    public Task<T> TransactionAsync<T>(Func<IUnitOfWork, Task<T>> work) => work(this);",
                    *VOID_TRANSACTION,
                    "}",
                ],
                repositories(),
            )
        )
    return files


CONNECTIONS = {
    "postgresql": "Host=localhost;Port=5432;Database=app;Username=app;Password=app",
    "mysql": "Server=localhost;Port=3306;Database=app;User ID=app;Password=app",
    "mariadb": "Server=localhost;Port=3306;Database=app;User ID=app;Password=app",
    "sqlite": "Data Source=app.db",
}


def default_connection(context: dict) -> str:
    return CONNECTIONS.get(context["settings"]["database"], CONNECTIONS["postgresql"])


def database_file(context: dict) -> dict:
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
    return _file(
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
