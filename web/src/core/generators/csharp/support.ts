/**
 * What every C# project shares: the domain errors services throw (no HTTP codes), the pages lists are read in,
 * Patch (a field of an update: absent, null or a value), the unit of work over the repositories, and the options
 * of the database DATABASE_CONNECTION names.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines } from '../types.ts'
import { csString, CsUsings } from './csharp.ts'
import { enumTypeName, pgEnums } from './entities.ts'
import {
  commonNamespace,
  errorsNamespace,
  memoryRepositoryClass,
  namespaceOf,
  pathOf,
  repositoryType,
  sqlRepositoryClass,
  writesEntities,
  type Context,
} from './context.ts'

function file(ns: string, name: string, body: string[], usings?: CsUsings): GeneratedFile {
  const written = usings?.write() ?? ''
  return { path: pathOf(ns, name), content: lines(written !== '' && [written, ''], `namespace ${ns};`, '', ...body, '') }
}

export function errorFiles(context: Context): GeneratedFile[] {
  const ns = errorsNamespace(context)
  return [
    file(ns, 'DomainException', [
      '/// <summary>Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them.</summary>',
      'public abstract class DomainException(string message) : Exception(message);',
    ]),
    file(ns, 'NotFoundException', [
      '/// <summary>No row has this key.</summary>',
      'public class NotFoundException(string entity, object key) : DomainException($"No {entity} has the key {key}")',
      '{',
      '    public string Entity { get; } = entity;',
      '    public object Key { get; } = key;',
      '}',
    ]),
    file(ns, 'ConflictException', [
      '/// <summary>The change clashes with what is stored: a unique value, a newer version, rows that depend on it.</summary>',
      'public class ConflictException(string entity, string reason, IReadOnlyList<string>? fields = null) : DomainException($"{entity}: {reason}")',
      '{',
      '    public string Entity { get; } = entity;',
      '    public string Reason { get; } = reason;',
      '    public IReadOnlyList<string> Fields { get; } = fields ?? [];',
      '}',
    ]),
    file(ns, 'FieldError', [
      '/// <summary>What is wrong with one field.</summary>',
      'public record FieldError(string Field, string Message);',
    ]),
    file(ns, 'ValidationFailedException', [
      '/// <summary>The values break the rules of the table: missing, too long, out of range, pointing nowhere.</summary>',
      'public class ValidationFailedException(string entity, IReadOnlyList<FieldError> errors)',
      '    : DomainException($"{entity}: {string.Join("; ", errors.Select(error => $"{error.Field}: {error.Message}"))}")',
      '{',
      '    public string Entity { get; } = entity;',
      '    public IReadOnlyList<FieldError> Errors { get; } = errors;',
      '}',
    ]),
  ]
}

export function commonFiles(context: Context): GeneratedFile[] {
  const ns = commonNamespace(context)
  const files: GeneratedFile[] = []
  if (context.settings.paging === 'offset')
    files.push(
      file(ns, 'Page', [
        '/// <summary>A page of a list: the rows from an offset, and how many there are in all.</summary>',
        'public record Page<T>(IReadOnlyList<T> Items, long Total, int Offset, int Limit)',
        '{',
        '    /// <summary>The same page with every row turned into something else.</summary>',
        '    public Page<TResult> Map<TResult>(Func<T, TResult> mapper) => new(Items.Select(mapper).ToList(), Total, Offset, Limit);',
        '}',
      ]),
    )
  if (context.settings.paging === 'cursor')
    files.push(
      file(ns, 'CursorPage', [
        '/// <summary>A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page).</summary>',
        'public record CursorPage<T>(IReadOnlyList<T> Items, IReadOnlyList<object>? Next)',
        '{',
        '    /// <summary>The same page with every row turned into something else.</summary>',
        '    public CursorPage<TResult> Map<TResult>(Func<T, TResult> mapper) => new(Items.Select(mapper).ToList(), Next);',
        '}',
      ]),
    )
  if (context.settings.services && context.settings.updates === 'patch')
    files.push(
      file(ns, 'Patch', [
        '/// <summary>A field of an update: absent (it keeps its value), or present with a value, which may be null.</summary>',
        'public sealed class Patch<T>',
        '{',
        '    private Patch(bool isPresent, T? value)',
        '    {',
        '        IsPresent = isPresent;',
        '        Value = value;',
        '    }',
        '',
        '    /// <summary>The field keeps its value.</summary>',
        '    public static Patch<T> Absent { get; } = new(false, default);',
        '',
        '    /// <summary>The field takes this value, which may be null.</summary>',
        '    public static Patch<T> Of(T? value) => new(true, value);',
        '',
        '    public bool IsPresent { get; }',
        '',
        '    /// <summary>The value to set; default when absent.</summary>',
        '    public T? Value { get; }',
        '',
        '    public override string ToString() => IsPresent ? $"Patch[{Value}]" : "Patch.Absent";',
        '}',
      ]),
    )
  return files
}

const HOW = {
  operation: 'Each service operation runs in TransactionAsync: committed when it ends, rolled back when it fails.',
  caller: 'Services never commit: whoever holds the AppDbContext opens and ends its transaction; TransactionAsync only groups the code.',
  repository: 'Every repository write is committed at once; TransactionAsync only groups the code.',
}

/** IUnitOfWork, SqlUnitOfWork and MemoryUnitOfWork, in the root namespace. */
export function unitOfWorkFiles(context: Context): GeneratedFile[] {
  const ns = context.base
  const settings = context.settings
  const repositories = (usings: CsUsings) => {
    for (const info of context.tables) usings.add(namespaceOf(context, info, 'repository'))
    return usings
  }
  const properties = (value: (info: Context['tables'][number]) => string) =>
    context.tables.map((info) => `    public ${repositoryType(context, info)} ${info.attr} { get; } = ${value(info)};`)
  const voidTransaction = [
    '',
    '    public Task TransactionAsync(Func<IUnitOfWork, Task> work) =>',
    '        TransactionAsync<bool>(async uow =>',
    '        {',
    '            await work(uow);',
    '            return true;',
    '        });',
  ]
  const files: GeneratedFile[] = [
    file(
      ns,
      'IUnitOfWork',
      [
        `/// <summary>What services depend on: a repository per table and a transaction. ${HOW[settings.transactions]}</summary>`,
        'public interface IUnitOfWork',
        '{',
        ...context.tables.map((info) => `    ${repositoryType(context, info)} ${info.attr} { get; }`),
        '',
        '    /// <summary>Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws.</summary>',
        '    Task<T> TransactionAsync<T>(Func<IUnitOfWork, Task<T>> work);',
        '',
        '    /// <summary>Runs work that returns nothing, in the same way.</summary>',
        '    Task TransactionAsync(Func<IUnitOfWork, Task> work);',
        '}',
      ],
      repositories(new CsUsings(ns)),
    ),
    file(
      ns,
      'SqlUnitOfWork',
      [
        '/// <summary>The repositories over one AppDbContext, and its transaction.</summary>',
        'public class SqlUnitOfWork(AppDbContext db) : IUnitOfWork',
        '{',
        '    public AppDbContext Db { get; } = db;',
        ...properties((info) => `new ${sqlRepositoryClass(info)}(db)`),
        '',
        '    public async Task<T> TransactionAsync<T>(Func<IUnitOfWork, Task<T>> work)',
        '    {',
        ...(settings.transactions === 'operation'
          ? [
              '        // Joins the transaction already open',
              '        if (Db.Database.CurrentTransaction is not null) return await work(this);',
              '        await using var transaction = await Db.Database.BeginTransactionAsync();',
              '        try',
              '        {',
              '            var result = await work(this);',
              '            await transaction.CommitAsync();',
              '            return result;',
              '        }',
              '        catch',
              '        {',
              '            await transaction.RollbackAsync();',
              '            Db.ChangeTracker.Clear();',
              '            throw;',
              '        }',
            ]
          : ['        return await work(this);']),
        '    }',
        ...voidTransaction,
        '}',
      ],
      repositories(new CsUsings(ns)),
    ),
  ]
  if (settings.memoryRepositories)
    files.push(
      file(
        ns,
        'MemoryUnitOfWork',
        [
          '/// <summary>The in-memory repositories, for tests and for trying the services without a database.</summary>',
          'public class MemoryUnitOfWork : IUnitOfWork',
          '{',
          ...properties((info) => `new ${memoryRepositoryClass(info)}()`),
          '',
          '    /// <summary>Memory has no transactions: changes are kept as they are made.</summary>',
          '    public Task<T> TransactionAsync<T>(Func<IUnitOfWork, Task<T>> work) => work(this);',
          ...voidTransaction,
          '}',
        ],
        repositories(new CsUsings(ns)),
      ),
    )
  return files
}

const CONNECTIONS: Record<string, string> = {
  postgresql: 'Host=localhost;Port=5432;Database=app;Username=app;Password=app',
  mysql: 'Server=localhost;Port=3306;Database=app;User ID=app;Password=app',
  mariadb: 'Server=localhost;Port=3306;Database=app;User ID=app;Password=app',
  sqlite: 'Data Source=app.db',
}

export const defaultConnection = (context: Context) => CONNECTIONS[context.settings.database] ?? CONNECTIONS.postgresql

/** `Database`: the options of the AppDbContext of the database DATABASE_CONNECTION names. */
export function databaseFile(context: Context): GeneratedFile {
  const ns = context.base
  const database = context.settings.database
  const enums = writesEntities(context) ? pgEnums(context) : []
  const use =
    database === 'postgresql'
      ? enums.length > 0
        ? `builder.UseNpgsql(connection, npgsql => npgsql${enums.map((item) => `.MapEnum<${enumTypeName(context, item)}>(${csString(item.name)})`).join('')})`
        : 'builder.UseNpgsql(connection)'
      : database === 'sqlite'
        ? 'builder.UseSqlite(connection)'
        : 'builder.UseMySql(connection, ServerVersion.AutoDetect(connection))'
  return file(
    ns,
    'Database',
    [
      '/// <summary>The database DATABASE_CONNECTION names (a connection string), through EF Core.</summary>',
      'public static class Database',
      '{',
      `    public const string DefaultConnection = "${defaultConnection(context)}";`,
      '',
      '    /// <summary>The connection string of DATABASE_CONNECTION, or the default one.</summary>',
      '    public static string Connection => Environment.GetEnvironmentVariable("DATABASE_CONNECTION") ?? DefaultConnection;',
      '',
      '    /// <summary>The options of an AppDbContext over the database at connection.</summary>',
      '    public static DbContextOptions<AppDbContext> Options(string connection)',
      '    {',
      '        var builder = new DbContextOptionsBuilder<AppDbContext>();',
      `        ${use};`,
      '        return builder.Options;',
      '    }',
      '',
      '    /// <summary>An AppDbContext over DATABASE_CONNECTION; dispose it when done.</summary>',
      '    public static AppDbContext Open() => new(Options(Connection));',
      '}',
    ],
    new CsUsings(ns).add('Microsoft.EntityFrameworkCore'),
  )
}
