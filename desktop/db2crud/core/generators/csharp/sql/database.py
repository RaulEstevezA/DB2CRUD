"""The database layer of a C# project without an ORM: Database, which opens the database DATABASE_CONNECTION names; Db,
what the repositories run their SQL with (one connection and its transaction, statements and their values as each driver
takes them, and the database's refusals); and the entities, plain classes with a property per column. Mirrors
web/src/core/generators/csharp/sql/database.ts."""

from ...types import lines
from ..context import namespace_of, path_of
from ..csharp import CsUsings
from ..support import default_connection, file


def _is_mysql(database: str) -> bool:
    return database in ("mysql", "mariadb")


def _database_file(context: dict) -> dict:
    """Database: the connection to the database DATABASE_CONNECTION names."""
    database = context["settings"]["database"]
    usings = CsUsings(context["base"]).add("System.Data.Common")
    if database == "postgresql":
        usings.add("Npgsql")
        create = ["    private static DbConnection Create(string connection) => new NpgsqlConnection(connection);"]
    elif _is_mysql(database):
        usings.add("MySqlConnector")
        create = [
            "    // Guids are kept as text: a CHAR(36) column is not always one",
            "    private static DbConnection Create(string connection) =>",
            "        new MySqlConnection(new MySqlConnectionStringBuilder(connection) { GuidFormat = MySqlGuidFormat.None }.ConnectionString);",
        ]
    else:
        usings.add("Microsoft.Data.Sqlite")
        create = [
            "    private static DbConnection Create(string connection) =>",
            "        new SqliteConnection(new SqliteConnectionStringBuilder(connection) { ForeignKeys = true }.ConnectionString);",
        ]
    return file(
        context["base"],
        "Database",
        [
            "/// <summary>The database DATABASE_CONNECTION names (a connection string), through its ADO.NET driver.</summary>",
            "public static class Database",
            "{",
            f'    public const string DefaultConnection = "{default_connection(context)}";',
            "",
            "    /// <summary>The connection string of DATABASE_CONNECTION, or the default one.</summary>",
            '    public static string Connection => Environment.GetEnvironmentVariable("DATABASE_CONNECTION") ?? DefaultConnection;',
            "",
            "    /// <summary>A Db over an open connection to the database at connection (DATABASE_CONNECTION when it is null); dispose it when done.</summary>",
            "    public static async Task<Db> OpenAsync(string? connection = null)",
            "    {",
            "        var opened = Create(connection ?? Connection);",
            "        try",
            "        {",
            "            await opened.OpenAsync();",
            "            return new Db(opened);",
            "        }",
            "        catch",
            "        {",
            "            await opened.DisposeAsync();",
            "            throw;",
            "        }",
            "    }",
            "",
            *create,
            "}",
        ],
        usings,
    )


_CULTURE = "CultureInfo.InvariantCulture"

_GETTERS = {
    "long": "GetInt64",
    "int": "GetInt32",
    "short": "GetInt16",
    "decimal": "GetDecimal",
    "double": "GetDouble",
    "float": "GetFloat",
    "bool": "GetBoolean",
    "byte[]": "GetFieldValue<byte[]>",
}


def _read_value(database: str, cs: str, at: int) -> tuple[str, str | None]:
    """How a value that is not null is read from a row, by the C# type of its column, and the namespace it needs."""
    sqlite = database == "sqlite"
    text = f"row.GetString({at})"
    if cs in _GETTERS:
        return f"row.{_GETTERS[cs]}({at})", None
    if cs == "Guid":
        return (f"row.GetGuid({at})" if database == "postgresql" else f"Guid.Parse({text})"), None
    if cs in ("DateOnly", "TimeOnly"):
        if sqlite:
            return f"{cs}.Parse({text}, {_CULTURE})", "System.Globalization"
        return f"row.GetFieldValue<{cs}>({at})", None
    if cs == "DateTime":
        if sqlite:
            return f"DateTime.Parse({text}, {_CULTURE}, DateTimeStyles.RoundtripKind)", "System.Globalization"
        return f"row.GetDateTime({at})", None
    if cs == "DateTimeOffset":
        # A time without its zone (all of MySQL's, and SQLite's CURRENT_TIMESTAMP) is in UTC
        if sqlite:
            return f"DateTimeOffset.Parse({text}, {_CULTURE}, DateTimeStyles.AssumeUniversal)", "System.Globalization"
        if _is_mysql(database):
            return f"new DateTimeOffset(row.GetDateTime({at}), TimeSpan.Zero)", None
        return f"row.GetFieldValue<DateTimeOffset>({at})", None
    return text, None


def read_column(context: dict, column: dict, index: int, usings: CsUsings) -> str:
    """A column of a row, as its property takes it."""
    code, using = _read_value(context["settings"]["database"], column["cs"], index)
    if using:
        usings.add(using)
    return f"row.IsDBNull({index}) ? null : {code}" if column["optional"] else code


def write_value(context: dict, column: dict, expression: str, nullable: bool, usings: CsUsings) -> str:
    """A value the driver takes as it is, unless the column needs it written another way."""
    # Npgsql has no type of its own for a time with its zone: it goes as its text
    if (
        context["settings"]["database"] == "postgresql"
        and column["column"]["type"]["kind"] == "time"
        and column["cs"] == "DateTimeOffset"
    ):
        usings.add("System.Globalization")
        return f'{expression}{"?" if nullable else ""}.ToString("HH:mm:ss.FFFFFFzzz", {_CULTURE})'
    return expression


_POSTGRESQL = {
    "using": ["Npgsql", "NpgsqlTypes"],
    "parameter": [
        "private static DbParameter Parameter(string name, object? value) => value switch",
        "{",
        "    null => new NpgsqlParameter(name, DBNull.Value),",
        "    // Texts are sent without a type, so PostgreSQL reads each one as its column has it: an enum, JSON",
        "    string text => new NpgsqlParameter(name, NpgsqlDbType.Unknown) { Value = text },",
        "    DateTime time => new NpgsqlParameter(name, NpgsqlDbType.Timestamp) { Value = DateTime.SpecifyKind(time, DateTimeKind.Unspecified) },",
        "    DateTimeOffset time => new NpgsqlParameter(name, time.ToUniversalTime()),",
        "    _ => new NpgsqlParameter(name, value),",
        "};",
    ],
    "refusal": [
        "// SQLSTATE class 23: integrity constraint violation",
        'private static bool IsRefusal(DbException error) => error.SqlState?.StartsWith("23", StringComparison.Ordinal) == true;',
    ],
}

_MYSQL = {
    "using": ["MySqlConnector"],
    "parameter": [
        "private static DbParameter Parameter(string name, object? value) => value switch",
        "{",
        "    null => new MySqlParameter(name, DBNull.Value),",
        "    Guid id => new MySqlParameter(name, id.ToString()),",
        "    // @@NAME@@ keeps no zone: the times are written in UTC",
        "    DateTimeOffset time => new MySqlParameter(name, time.UtcDateTime),",
        "    _ => new MySqlParameter(name, value),",
        "};",
    ],
    "refusal": [
        "// SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)",
        "private static bool IsRefusal(DbException error) =>",
        '    error is MySqlException refused && (refused.SqlState?.StartsWith("23", StringComparison.Ordinal) == true || refused.Number is 3819 or 4025);',
    ],
}

_SQLITE = {
    "using": ["Microsoft.Data.Sqlite"],
    "parameter": [
        "private static DbParameter Parameter(string name, object? value) => value switch",
        "{",
        "    null => new SqliteParameter(name, DBNull.Value),",
        "    Guid id => new SqliteParameter(name, id.ToString()),",
        "    // SQLite compares times as texts: they are all written in UTC",
        "    DateTimeOffset time => new SqliteParameter(name, time.ToUniversalTime()),",
        "    _ => new SqliteParameter(name, value),",
        "};",
    ],
    "refusal": [
        "// SQLITE_CONSTRAINT, whatever its extended code",
        "private static bool IsRefusal(DbException error) => error is SqliteException { SqliteErrorCode: 19 };",
    ],
}


def _driver_of(database: str) -> dict:
    """What each driver needs told apart: the parameters it takes and how it says the database refused a write."""
    if database == "postgresql":
        return _POSTGRESQL
    if _is_mysql(database):
        name = "MySQL" if database == "mysql" else "MariaDB"
        return {**_MYSQL, "parameter": [line.replace("@@NAME@@", name) for line in _MYSQL["parameter"]]}
    return _SQLITE


def _db_file(context: dict) -> dict:
    """Db: what the repositories run their SQL with."""
    database = context["settings"]["database"]
    driver = _driver_of(database)
    usings = CsUsings(context["base"]).add("System.Data.Common", *driver["using"])
    body = [
        "/// <summary>The database refused a write: a unique value taken, a row still pointed to, a value against its rules.</summary>",
        "public sealed class RefusedException(DbException cause) : Exception(cause.Message, cause);",
        "",
        "/// <summary>One open connection and its transaction: what the repositories run their SQL with. The values of a statement are its @p1, @p2…, in order.</summary>",
        "public sealed class Db(DbConnection connection) : IAsyncDisposable",
        "{",
        "    private DbTransaction? transaction;",
        "",
        "    public DbConnection Connection { get; } = connection;",
        "",
        "    /// <summary>A transaction is open.</summary>",
        "    public bool InTransaction => transaction is not null;",
        "",
        "    /// <summary>Opens the transaction every statement runs in until CommitAsync or RollbackAsync.</summary>",
        "    public async Task BeginAsync() => transaction = await Connection.BeginTransactionAsync();",
        "",
        "    public async Task CommitAsync()",
        "    {",
        '        if (transaction is null) throw new InvalidOperationException("There is no transaction to commit");',
        "        await using var ending = transaction;",
        "        transaction = null;",
        "        await ending.CommitAsync();",
        "    }",
        "",
        "    /// <summary>Undoes the open transaction, when there is one.</summary>",
        "    public async Task RollbackAsync()",
        "    {",
        "        if (transaction is null) return;",
        "        await using var ending = transaction;",
        "        transaction = null;",
        "        await ending.RollbackAsync();",
        "    }",
        "",
        "    /// <summary>Every row of a query.</summary>",
        "    public Task<List<T>> AllAsync<T>(string sql, Func<DbDataReader, T> read, params object?[] values) =>",
        "        ExecuteAsync(sql, values, async command =>",
        "        {",
        "            await using var rows = await command.ExecuteReaderAsync();",
        "            var result = new List<T>();",
        "            while (await rows.ReadAsync()) result.Add(read(rows));",
        "            return result;",
        "        });",
        "",
        "    /// <summary>The first row of a query, or null.</summary>",
        "    public async Task<T?> OneAsync<T>(string sql, Func<DbDataReader, T> read, params object?[] values) =>",
        "        (await AllAsync(sql, read, values)).FirstOrDefault();",
        "",
        "    /// <summary>Runs a statement that reads nothing back.</summary>",
        "    public Task RunAsync(string sql, params object?[] values) => ExecuteAsync(sql, values, command => command.ExecuteNonQueryAsync());",
        _is_mysql(database)
        and [
            "",
            "    /// <summary>Runs an insert; the id the database gave the new row, when it numbers them.</summary>",
            "    public Task<long> InsertAsync(string sql, params object?[] values) =>",
            "        ExecuteAsync(sql, values, async command =>",
            "        {",
            "            await command.ExecuteNonQueryAsync();",
            "            return ((MySqlCommand)command).LastInsertedId;",
            "        });",
        ],
        "",
        "    /// <summary>The markers of the first count values: @p1, @p2…</summary>",
        '    public static string Markers(int count) => string.Join(", ", Enumerable.Range(1, count).Select(number => $"@p{number}"));',
        "",
        "    /// <summary>Closes the connection; a transaction still open is undone.</summary>",
        "    public async ValueTask DisposeAsync()",
        "    {",
        "        if (transaction is not null) await transaction.DisposeAsync();",
        "        transaction = null;",
        "        await Connection.DisposeAsync();",
        "    }",
        "",
        "    private async Task<T> ExecuteAsync<T>(string sql, object?[] values, Func<DbCommand, Task<T>> run)",
        "    {",
        "        await using var command = Connection.CreateCommand();",
        "        command.CommandText = sql;",
        "        command.Transaction = transaction;",
        '        for (var index = 0; index < values.Length; index++) command.Parameters.Add(Parameter($"@p{index + 1}", values[index]));',
        "        try",
        "        {",
        "            return await run(command);",
        "        }",
        "        catch (DbException error) when (IsRefusal(error))",
        "        {",
        "            throw new RefusedException(error);",
        "        }",
        "    }",
        "",
        "    /// <summary>A value as the driver takes it.</summary>",
        *(f"    {line}" for line in driver["parameter"]),
        "",
        *(f"    {line}" for line in driver["refusal"]),
        "}",
    ]
    return file(context["base"], "Db", body, usings)


def sql_entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a plain class with a property per column."""
    ns = namespace_of(context, info, "entity")
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    kept = " (an array literal of PostgreSQL)" if context["settings"]["database"] == "postgresql" else " (JSON)"
    properties: list = []
    for index, column in enumerate(info["columns"]):
        kind = column["column"]["type"]["kind"]
        sql = column["column"]["type"]["sql"]
        initializer = " = null!;" if not column["optional"] and not column["valueType"] else ""
        properties += [
            "" if index > 0 else None,
            bool(column["column"].get("comment")) and f"    /// <summary>{column['column'].get('comment')}</summary>",
            kind == "unknown" and f'    // TODO: "{sql}" has no C# type here; it is kept as its text',
            kind == "array" and f'    // TODO: "{sql}" is kept as its text{kept}',
            f"    public {column['propType']} {column['prop']} {{ get; set; }}{initializer}",
        ]
    content = lines(
        f"namespace {ns};",
        "",
        f'/// <summary>A row of the "{info["name"]}" table{comment}. The repositories read and write it with SQL.</summary>',
        f"public class {info['entity']}",
        "{",
        *properties,
        "}",
        "",
    )
    return {"path": path_of(ns, info["entity"]), "content": content}


def sql_database_files(context: dict) -> list[dict]:
    return [_database_file(context), _db_file(context)]
