/**
 * C# + EF Core 9 (Strategy of orm.ts): entities mapped as the database has them in AppDbContext, repositories over it, a
 * unit of work whose transaction is the context's, and tests on a database EF Core creates from the mapping.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Line } from '../../types.ts'
import { csString, CsUsings } from '../csharp.ts'
import { writesEntities, type Context } from '../context.ts'
import type { CsharpOrm } from '../orm.ts'
import { defaultConnection, file } from '../support.ts'
import { testFile, testsNs } from '../tests.ts'
import { dbContextFile, entityFile, enumTypeName, pgEnums, pgEnumsFile } from './entities.ts'
import { efBody, efTail } from './repository.ts'

const VERSIONS = {
  efCore: '9.0.23',
  npgsql: '9.0.4',
  pomelo: '9.0.0',
}

const PROVIDERS: Record<string, [string, string]> = {
  postgresql: ['Npgsql.EntityFrameworkCore.PostgreSQL', VERSIONS.npgsql],
  mysql: ['Pomelo.EntityFrameworkCore.MySql', VERSIONS.pomelo],
  mariadb: ['Pomelo.EntityFrameworkCore.MySql', VERSIONS.pomelo],
  sqlite: ['Microsoft.EntityFrameworkCore.Sqlite', VERSIONS.efCore],
}

/** `Database`: the options of the AppDbContext of the database DATABASE_CONNECTION names. */
function databaseFile(context: Context): GeneratedFile {
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

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const usings = new CsUsings(testsNs(context)).add(context.base)
  if (sqlite) usings.add('Microsoft.Data.Sqlite', 'Microsoft.EntityFrameworkCore')
  return testFile(context, 'TestDatabase', usings, [
    sqlite
      ? '/// <summary>The test database: TEST_DATABASE_CONNECTION, or SQLite in memory, created empty from the mapping for every test.</summary>'
      : `/// <summary>The test database: the ${NAMES[database]} database TEST_DATABASE_CONNECTION names, created empty from the mapping for every test.</summary>`,
    'public sealed class TestDatabase : IAsyncDisposable',
    '{',
    '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
    '',
    sqlite && ['    private readonly SqliteConnection? memory;', ''],
    sqlite ? '    private TestDatabase(AppDbContext db, SqliteConnection? memory)' : '    private TestDatabase(AppDbContext db)',
    '    {',
    '        Db = db;',
    sqlite && '        this.memory = memory;',
    '    }',
    '',
    '    public AppDbContext Db { get; }',
    '',
    '    /// <summary>The test database, with every table dropped and created again.</summary>',
    '    public static async Task<TestDatabase> OpenAsync()',
    '    {',
    ...(sqlite
      ? [
          '        SqliteConnection? memory = null;',
          '        DbContextOptions<AppDbContext> options;',
          '        if (Connection is null)',
          '        {',
          '            // An in-memory database lives as long as its connection is open',
          '            memory = new SqliteConnection("Data Source=:memory:");',
          '            memory.Open();',
          '            options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(memory).Options;',
          '        }',
          '        else options = Database.Options(Connection);',
          '        var db = new AppDbContext(options);',
        ]
      : [
          '        // The mapping is written for one kind of database: the tests cannot fall back to SQLite',
          '        if (Connection is null)',
          `            throw new InvalidOperationException("The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_CONNECTION (it is emptied)");`,
          '        var db = new AppDbContext(Database.Options(Connection));',
        ]),
    '        await db.Database.EnsureDeletedAsync();',
    '        await db.Database.EnsureCreatedAsync();',
    sqlite ? '        return new TestDatabase(db, memory);' : '        return new TestDatabase(db);',
    '    }',
    '',
    '    public async ValueTask DisposeAsync()',
    '    {',
    '        await Db.DisposeAsync();',
    sqlite && '        if (memory is not null) await memory.DisposeAsync();',
    '    }',
    '}',
  ])
}

function databaseTestsFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const sql =
    database === 'postgresql'
      ? 'SELECT current_database() AS "Value"'
      : sqlite
        ? 'SELECT sqlite_version() AS "Value"'
        : 'SELECT DATABASE() AS Value'
  return testFile(context, 'DatabaseTests', new CsUsings(testsNs(context)).add('Microsoft.EntityFrameworkCore', 'Xunit'), [
    '/// <summary>The tests run on the database they were asked to.</summary>',
    'public class DatabaseTests',
    '{',
    '    [Fact]',
    sqlite ? '    public async Task IsSqlite()' : '    public async Task IsTheOneTestDatabaseConnectionNames()',
    '    {',
    '        await using var database = await TestDatabase.OpenAsync();',
    `        var value = await database.Db.Database.SqlQueryRaw<string>(${csString(sql)}).SingleAsync();`,
    sqlite ? '        Assert.StartsWith("3.", value);' : '        Assert.Equal(database.Db.Database.GetDbConnection().Database, value);',
    '    }',
    '}',
  ])
}

/** The fields, setup and teardown of a test class over the test database. */
function testMembers(context: Context): Line[] {
  const caller = context.settings.transactions === 'caller'
  return [
    '    private TestDatabase database = null!;',
    '',
    '    /// <summary>The repositories over the test database, opened empty for every test</summary>',
    '    private SqlUnitOfWork uow = null!;',
    '',
    '    public async ValueTask InitializeAsync()',
    '    {',
    '        database = await TestDatabase.OpenAsync();',
    caller && '        // The caller owns the transaction: the test opens it, and it ends with the test',
    caller && '        await database.Db.Database.BeginTransactionAsync();',
    '        uow = new SqlUnitOfWork(database.Db);',
    '    }',
    '',
    '    public async ValueTask DisposeAsync() => await database.DisposeAsync();',
  ]
}

export const efcoreOrm: CsharpOrm = {
  id: 'efcore',
  holder: 'AppDbContext',
  forget: 'uow.Db.ChangeTracker.Clear();',
  emptyList: () => '"[]"',
  databaseFiles: (context) => [dbContextFile(context), pgEnumsFile(context), databaseFile(context)],
  entityFile,
  repository: {
    usings: ['Microsoft.EntityFrameworkCore'],
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through AppDbContext. ${
        context.settings.transactions === 'caller'
          ? 'Writes run in the transaction of whoever holds the AppDbContext, when there is one.'
          : 'A write joins the transaction already open, or is committed at once.'
      }`,
    head: () => [],
    body: efBody,
    tail: (_, info) => efTail(info),
  },
  transaction: [
    '// Joins the transaction already open',
    'if (Db.Database.CurrentTransaction is not null) return await work(this);',
    'await using var transaction = await Db.Database.BeginTransactionAsync();',
    'try',
    '{',
    '    var result = await work(this);',
    '    await transaction.CommitAsync();',
    '    return result;',
    '}',
    'catch',
    '{',
    '    await transaction.RollbackAsync();',
    '    Db.ChangeTracker.Clear();',
    '    throw;',
    '}',
  ],
  testDatabaseFiles: (context) => [testDatabaseFile(context), databaseTestsFile(context)],
  testMembers,
  packages: (context) => [
    ['Microsoft.EntityFrameworkCore.Relational', VERSIONS.efCore],
    PROVIDERS[context.settings.database] ?? PROVIDERS.postgresql,
  ],
  readme: {
    intro: 'entities mapped with EF Core 9, repositories over `AppDbContext` and services',
    layout: [
      'src/App/AppDbContext.cs          the mapping of every table, as the database has it',
      'src/App/Database.cs              the options of DATABASE_CONNECTION',
    ],
    reset: 'it is deleted and created again',
  },
}
