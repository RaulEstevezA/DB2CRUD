"""What every C# project shares: the domain errors services throw (no HTTP codes), the pages lists are read in, Patch
(a field of an update: absent, null or a value), and the unit of work over the repositories (what its database class does
is the strategy's). Mirrors web/src/core/generators/csharp/support.ts."""

from ..types import lines
from .context import (
    common_namespace,
    errors_namespace,
    memory_repository_class,
    namespace_of,
    path_of,
    repository_type,
    sql_repository_class,
)
from .csharp import CsUsings

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


def file(ns: str, name: str, body: list, usings: CsUsings | None = None) -> dict:
    written = usings.write() if usings else ""
    return {
        "path": path_of(ns, name),
        "content": lines(written != "" and [written, ""], f"namespace {ns};", "", *body, ""),
    }


def error_files(context: dict) -> list[dict]:
    ns = errors_namespace(context)
    return [
        file(ns, "DomainException", DOMAINEXCEPTION),
        file(ns, "NotFoundException", NOTFOUNDEXCEPTION),
        file(ns, "ConflictException", CONFLICTEXCEPTION),
        file(ns, "FieldError", FIELDERROR),
        file(ns, "ValidationFailedException", VALIDATIONFAILEDEXCEPTION),
    ]


def common_files(context: dict) -> list[dict]:
    ns = common_namespace(context)
    settings = context["settings"]
    files = []
    if settings["paging"] == "offset":
        files.append(file(ns, "Page", PAGE))
    if settings["paging"] == "cursor":
        files.append(file(ns, "CursorPage", CURSORPAGE))
    if settings["services"] and settings["updates"] == "patch":
        files.append(file(ns, "Patch", PATCH))
    return files


def _how(context: dict) -> dict:
    return {
        "operation": "Each service operation runs in TransactionAsync: committed when it ends, rolled back when it fails.",
        "caller": f"Services never commit: whoever holds the {context['orm']['holder']} opens and ends its transaction; TransactionAsync only groups the code.",
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
        transaction = [f"        {line}" for line in context["orm"]["transaction"]]
    else:
        transaction = ["        return await work(this);"]
    files = [
        file(
            ns,
            "IUnitOfWork",
            [
                f"/// <summary>What services depend on: a repository per table and a transaction. {_how(context)[settings['transactions']]}</summary>",
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
        file(
            ns,
            "SqlUnitOfWork",
            [
                f"/// <summary>The repositories over one {context['orm']['holder']}, and its transaction.</summary>",
                f"public class SqlUnitOfWork({context['orm']['holder']} db) : IUnitOfWork",
                "{",
                f"    public {context['orm']['holder']} Db {{ get; }} = db;",
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
            file(
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
    "mongodb": "mongodb://localhost:27017/app",
}


def default_connection(context: dict) -> str:
    return CONNECTIONS.get(context["settings"]["database"], CONNECTIONS["postgresql"])
