/**
 * The database layer of a C# project without an ORM: `Database`, which opens the database DATABASE_CONNECTION names; `Db`,
 * what the repositories run their SQL with (one connection and its transaction, statements and their values as each driver
 * takes them, and the database's refusals); and the entities, plain classes with a property per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Dialect } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { CsUsings } from '../csharp.ts'
import { namespaceOf, pathOf, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { defaultConnection, file } from '../support.ts'

const isMysql = (database: Dialect) => database === 'mysql' || database === 'mariadb'

/** `Database`: the connection to the database DATABASE_CONNECTION names. */
function databaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const usings = new CsUsings(context.base).add('System.Data.Common')
  let create: string[]
  if (database === 'postgresql') {
    usings.add('Npgsql')
    create = ['    private static DbConnection Create(string connection) => new NpgsqlConnection(connection);']
  } else if (isMysql(database)) {
    usings.add('MySqlConnector')
    create = [
      '    // Guids are kept as text: a CHAR(36) column is not always one',
      '    private static DbConnection Create(string connection) =>',
      '        new MySqlConnection(new MySqlConnectionStringBuilder(connection) { GuidFormat = MySqlGuidFormat.None }.ConnectionString);',
    ]
  } else {
    usings.add('Microsoft.Data.Sqlite')
    create = [
      '    private static DbConnection Create(string connection) =>',
      '        new SqliteConnection(new SqliteConnectionStringBuilder(connection) { ForeignKeys = true }.ConnectionString);',
    ]
  }
  return file(
    context.base,
    'Database',
    [
      '/// <summary>The database DATABASE_CONNECTION names (a connection string), through its ADO.NET driver.</summary>',
      'public static class Database',
      '{',
      `    public const string DefaultConnection = "${defaultConnection(context)}";`,
      '',
      '    /// <summary>The connection string of DATABASE_CONNECTION, or the default one.</summary>',
      '    public static string Connection => Environment.GetEnvironmentVariable("DATABASE_CONNECTION") ?? DefaultConnection;',
      '',
      '    /// <summary>A Db over an open connection to the database at connection (DATABASE_CONNECTION when it is null); dispose it when done.</summary>',
      '    public static async Task<Db> OpenAsync(string? connection = null)',
      '    {',
      '        var opened = Create(connection ?? Connection);',
      '        try',
      '        {',
      '            await opened.OpenAsync();',
      '            return new Db(opened);',
      '        }',
      '        catch',
      '        {',
      '            await opened.DisposeAsync();',
      '            throw;',
      '        }',
      '    }',
      '',
      ...create,
      '}',
    ],
    usings,
  )
}

const CULTURE = 'CultureInfo.InvariantCulture'

/** How a value that is not null is read from a row, by the C# type of its column, and the namespace it needs. */
function readValue(database: Dialect, cs: string, at: string): { code: string; using?: string } {
  const sqlite = database === 'sqlite'
  const text = `row.GetString(${at})`
  switch (cs) {
    case 'long':
      return { code: `row.GetInt64(${at})` }
    case 'int':
      return { code: `row.GetInt32(${at})` }
    case 'short':
      return { code: `row.GetInt16(${at})` }
    case 'decimal':
      return { code: `row.GetDecimal(${at})` }
    case 'double':
      return { code: `row.GetDouble(${at})` }
    case 'float':
      return { code: `row.GetFloat(${at})` }
    case 'bool':
      return { code: `row.GetBoolean(${at})` }
    case 'byte[]':
      return { code: `row.GetFieldValue<byte[]>(${at})` }
    case 'Guid':
      return { code: database === 'postgresql' ? `row.GetGuid(${at})` : `Guid.Parse(${text})` }
    case 'DateOnly':
    case 'TimeOnly':
      return sqlite
        ? { code: `${cs}.Parse(${text}, ${CULTURE})`, using: 'System.Globalization' }
        : { code: `row.GetFieldValue<${cs}>(${at})` }
    case 'DateTime':
      return sqlite
        ? { code: `DateTime.Parse(${text}, ${CULTURE}, DateTimeStyles.RoundtripKind)`, using: 'System.Globalization' }
        : { code: `row.GetDateTime(${at})` }
    case 'DateTimeOffset':
      // A time without its zone (all of MySQL's, and SQLite's CURRENT_TIMESTAMP) is in UTC
      if (sqlite)
        return { code: `DateTimeOffset.Parse(${text}, ${CULTURE}, DateTimeStyles.AssumeUniversal)`, using: 'System.Globalization' }
      return {
        code: isMysql(database) ? `new DateTimeOffset(row.GetDateTime(${at}), TimeSpan.Zero)` : `row.GetFieldValue<DateTimeOffset>(${at})`,
      }
    default:
      return { code: text }
  }
}

/** A column of a row, as its property takes it. */
export function readColumn(context: Context, column: ColumnInfo, index: number, usings: CsUsings): string {
  const { code, using } = readValue(context.settings.database, column.cs, String(index))
  if (using) usings.add(using)
  return column.optional ? `row.IsDBNull(${index}) ? null : ${code}` : code
}

/** A value the driver takes as it is, unless the column needs it written another way. */
export function writeValue(context: Context, column: ColumnInfo, expression: string, nullable: boolean, usings: CsUsings): string {
  // Npgsql has no type of its own for a time with its zone: it goes as its text
  if (context.settings.database === 'postgresql' && column.column.type.kind === 'time' && column.cs === 'DateTimeOffset') {
    usings.add('System.Globalization')
    return `${expression}${nullable ? '?' : ''}.ToString("HH:mm:ss.FFFFFFzzz", ${CULTURE})`
  }
  return expression
}

interface Driver {
  using: string[]
  parameter: string[]
  refusal: string[]
}

/** What each driver needs told apart: the parameters it takes and how it says the database refused a write. */
function driverOf(database: Dialect): Driver {
  if (database === 'postgresql')
    return {
      using: ['Npgsql', 'NpgsqlTypes'],
      parameter: [
        'private static DbParameter Parameter(string name, object? value) => value switch',
        '{',
        '    null => new NpgsqlParameter(name, DBNull.Value),',
        '    // Texts are sent without a type, so PostgreSQL reads each one as its column has it: an enum, JSON',
        '    string text => new NpgsqlParameter(name, NpgsqlDbType.Unknown) { Value = text },',
        '    DateTime time => new NpgsqlParameter(name, NpgsqlDbType.Timestamp) { Value = DateTime.SpecifyKind(time, DateTimeKind.Unspecified) },',
        '    DateTimeOffset time => new NpgsqlParameter(name, time.ToUniversalTime()),',
        '    _ => new NpgsqlParameter(name, value),',
        '};',
      ],
      refusal: [
        '// SQLSTATE class 23: integrity constraint violation',
        'private static bool IsRefusal(DbException error) => error.SqlState?.StartsWith("23", StringComparison.Ordinal) == true;',
      ],
    }
  if (isMysql(database))
    return {
      using: ['MySqlConnector'],
      parameter: [
        'private static DbParameter Parameter(string name, object? value) => value switch',
        '{',
        '    null => new MySqlParameter(name, DBNull.Value),',
        '    Guid id => new MySqlParameter(name, id.ToString()),',
        `    // ${database === 'mysql' ? 'MySQL' : 'MariaDB'} keeps no zone: the times are written in UTC`,
        '    DateTimeOffset time => new MySqlParameter(name, time.UtcDateTime),',
        '    _ => new MySqlParameter(name, value),',
        '};',
      ],
      refusal: [
        '// SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)',
        'private static bool IsRefusal(DbException error) =>',
        '    error is MySqlException refused && (refused.SqlState?.StartsWith("23", StringComparison.Ordinal) == true || refused.Number is 3819 or 4025);',
      ],
    }
  return {
    using: ['Microsoft.Data.Sqlite'],
    parameter: [
      'private static DbParameter Parameter(string name, object? value) => value switch',
      '{',
      '    null => new SqliteParameter(name, DBNull.Value),',
      '    Guid id => new SqliteParameter(name, id.ToString()),',
      '    // SQLite compares times as texts: they are all written in UTC',
      '    DateTimeOffset time => new SqliteParameter(name, time.ToUniversalTime()),',
      '    _ => new SqliteParameter(name, value),',
      '};',
    ],
    refusal: [
      '// SQLITE_CONSTRAINT, whatever its extended code',
      'private static bool IsRefusal(DbException error) => error is SqliteException { SqliteErrorCode: 19 };',
    ],
  }
}

/** `Db`: what the repositories run their SQL with. */
function dbFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const driver = driverOf(database)
  const usings = new CsUsings(context.base).add('System.Data.Common', ...driver.using)
  const inside = (items: string[]) => items.map((line) => `    ${line}`)
  const body: (Line | Line[])[] = [
    '/// <summary>The database refused a write: a unique value taken, a row still pointed to, a value against its rules.</summary>',
    'public sealed class RefusedException(DbException cause) : Exception(cause.Message, cause);',
    '',
    '/// <summary>One open connection and its transaction: what the repositories run their SQL with. The values of a statement are its @p1, @p2…, in order.</summary>',
    'public sealed class Db(DbConnection connection) : IAsyncDisposable',
    '{',
    '    private DbTransaction? transaction;',
    '',
    '    public DbConnection Connection { get; } = connection;',
    '',
    '    /// <summary>A transaction is open.</summary>',
    '    public bool InTransaction => transaction is not null;',
    '',
    '    /// <summary>Opens the transaction every statement runs in until CommitAsync or RollbackAsync.</summary>',
    '    public async Task BeginAsync() => transaction = await Connection.BeginTransactionAsync();',
    '',
    '    public async Task CommitAsync()',
    '    {',
    '        if (transaction is null) throw new InvalidOperationException("There is no transaction to commit");',
    '        await using var ending = transaction;',
    '        transaction = null;',
    '        await ending.CommitAsync();',
    '    }',
    '',
    '    /// <summary>Undoes the open transaction, when there is one.</summary>',
    '    public async Task RollbackAsync()',
    '    {',
    '        if (transaction is null) return;',
    '        await using var ending = transaction;',
    '        transaction = null;',
    '        await ending.RollbackAsync();',
    '    }',
    '',
    '    /// <summary>Every row of a query.</summary>',
    '    public Task<List<T>> AllAsync<T>(string sql, Func<DbDataReader, T> read, params object?[] values) =>',
    '        ExecuteAsync(sql, values, async command =>',
    '        {',
    '            await using var rows = await command.ExecuteReaderAsync();',
    '            var result = new List<T>();',
    '            while (await rows.ReadAsync()) result.Add(read(rows));',
    '            return result;',
    '        });',
    '',
    '    /// <summary>The first row of a query, or null.</summary>',
    '    public async Task<T?> OneAsync<T>(string sql, Func<DbDataReader, T> read, params object?[] values) =>',
    '        (await AllAsync(sql, read, values)).FirstOrDefault();',
    '',
    '    /// <summary>Runs a statement that reads nothing back.</summary>',
    '    public Task RunAsync(string sql, params object?[] values) => ExecuteAsync(sql, values, command => command.ExecuteNonQueryAsync());',
    isMysql(database) && [
      '',
      '    /// <summary>Runs an insert; the id the database gave the new row, when it numbers them.</summary>',
      '    public Task<long> InsertAsync(string sql, params object?[] values) =>',
      '        ExecuteAsync(sql, values, async command =>',
      '        {',
      '            await command.ExecuteNonQueryAsync();',
      '            return ((MySqlCommand)command).LastInsertedId;',
      '        });',
    ],
    '',
    '    /// <summary>The markers of the first count values: @p1, @p2…</summary>',
    '    public static string Markers(int count) => string.Join(", ", Enumerable.Range(1, count).Select(number => $"@p{number}"));',
    '',
    '    /// <summary>Closes the connection; a transaction still open is undone.</summary>',
    '    public async ValueTask DisposeAsync()',
    '    {',
    '        if (transaction is not null) await transaction.DisposeAsync();',
    '        transaction = null;',
    '        await Connection.DisposeAsync();',
    '    }',
    '',
    '    private async Task<T> ExecuteAsync<T>(string sql, object?[] values, Func<DbCommand, Task<T>> run)',
    '    {',
    '        await using var command = Connection.CreateCommand();',
    '        command.CommandText = sql;',
    '        command.Transaction = transaction;',
    '        for (var index = 0; index < values.Length; index++) command.Parameters.Add(Parameter($"@p{index + 1}", values[index]));',
    '        try',
    '        {',
    '            return await run(command);',
    '        }',
    '        catch (DbException error) when (IsRefusal(error))',
    '        {',
    '            throw new RefusedException(error);',
    '        }',
    '    }',
    '',
    '    /// <summary>A value as the driver takes it.</summary>',
    ...inside(driver.parameter),
    '',
    ...inside(driver.refusal),
    '}',
  ]
  return file(context.base, 'Db', body, usings)
}

/** The entity of a table: a plain class with a property per column. */
export function sqlEntityFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const content = lines(
    `namespace ${ns};`,
    '',
    `/// <summary>A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. The repositories read and write it with SQL.</summary>`,
    `public class ${info.entity}`,
    '{',
    ...info.columns.flatMap((column, index) => [
      index > 0 ? '' : null,
      column.column.comment && `    /// <summary>${column.column.comment}</summary>`,
      column.column.type.kind === 'unknown' && `    // TODO: "${column.column.type.sql}" has no C# type here; it is kept as its text`,
      column.column.type.kind === 'array' &&
        `    // TODO: "${column.column.type.sql}" is kept as its text${context.settings.database === 'postgresql' ? ' (an array literal of PostgreSQL)' : ' (JSON)'}`,
      `    public ${column.propType} ${column.prop} { get; set; }${!column.optional && !column.valueType ? ' = null!;' : ''}`,
    ]),
    '}',
    '',
  )
  return { path: pathOf(ns, info.entity), content }
}

export const sqlDatabaseFiles = (context: Context) => [databaseFile(context), dbFile(context)]
