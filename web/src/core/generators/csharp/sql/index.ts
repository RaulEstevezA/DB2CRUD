/**
 * C# without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through ADO.NET over one connection
 * (sql/database.ts holds it and the helpers), plain classes as entities, a unit of work whose transaction is the
 * connection's, and tests on a real database created from the schema's DDL (SQLite in memory, or the database
 * TEST_DATABASE_CONNECTION names: the DDL is written for one kind of database). Mirrors java/sql/index.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import type { Line } from '../../types.ts'
import { csString, CsUsings } from '../csharp.ts'
import type { Context } from '../context.ts'
import type { CsharpOrm } from '../orm.ts'
import { testFile, testsNs } from '../tests.ts'
import { sqlDatabaseFiles, sqlEntityFile } from './database.ts'
import { sqlBody, sqlHead, sqlTail } from './repository.ts'

const DRIVERS: Record<string, [string, string]> = {
  postgresql: ['Npgsql', '10.0.4'],
  mysql: ['MySqlConnector', '2.6.2'],
  mariadb: ['MySqlConnector', '2.6.2'],
  sqlite: ['Microsoft.Data.Sqlite', '10.0.15'],
}

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

/** TestDatabase: a Db on the test database, with every table dropped and created again from the schema's DDL. */
function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const list = (name: string, doc: string, statements: string[]) => [
    `    /// <summary>${doc}</summary>`,
    `    private static readonly string[] ${name} =`,
    '    [',
    ...statements.map((statement) => `        ${csString(statement)},`),
    '    ];',
  ]
  return testFile(context, 'TestDatabase', new CsUsings(testsNs(context)).add(context.base), [
    sqlite
      ? '/// <summary>The test database: TEST_DATABASE_CONNECTION, or SQLite in memory, created from the schema before every test.</summary>'
      : `/// <summary>The test database: the ${NAMES[database]} database TEST_DATABASE_CONNECTION names, created from the schema before every test.</summary>`,
    'internal static class TestDatabase',
    '{',
    sqlite
      ? [
          '    // An in-memory database lives as long as its connection is open',
          '    public static readonly string Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION") ?? "Data Source=:memory:";',
        ]
      : [
          '    // The tables are written for one kind of database: the tests cannot fall back to SQLite',
          '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
        ],
    '',
    ...list('Drop', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database)),
    '',
    ...list('Create', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database)),
    '',
    '    /// <summary>The test database, with every table dropped and created again; on one connection, as MySQL turns its foreign key checks off for the connection that asks.</summary>',
    '    public static async Task<Db> OpenAsync()',
    '    {',
    !sqlite && [
      '        if (Connection is null)',
      `            throw new InvalidOperationException("The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_CONNECTION (it is emptied)");`,
    ],
    '        var db = await Database.OpenAsync(Connection);',
    '        foreach (var sql in Drop) await db.RunAsync(sql);',
    '        foreach (var sql in Create) await db.RunAsync(sql);',
    '        return db;',
    '    }',
    '}',
  ])
}

function databaseTestsFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  const usings = new CsUsings(testsNs(context)).add('Xunit')
  if (!sqlite) usings.add('System.Data.Common')
  return testFile(context, 'DatabaseTests', usings, [
    '/// <summary>The tests run on the database they were asked to.</summary>',
    'public class DatabaseTests',
    '{',
    '    [Fact]',
    sqlite ? '    public async Task IsSqlite()' : '    public async Task IsTheOneTestDatabaseConnectionNames()',
    '    {',
    '        await using var db = await TestDatabase.OpenAsync();',
    `        var value = await db.OneAsync(${csString(sql)}, row => row.GetString(0));`,
    sqlite
      ? '        Assert.StartsWith("3.", value);'
      : [
          '        var asked = new DbConnectionStringBuilder { ConnectionString = TestDatabase.Connection };',
          '        Assert.Equal(asked["Database"], value);',
        ],
    '    }',
    '}',
  ])
}

/** A Db on the test database for every test, and the unit of work over it. */
function testMembers(context: Context): Line[] {
  const caller = context.settings.transactions === 'caller'
  return [
    '    private Db db = null!;',
    '',
    '    /// <summary>The repositories over the test database, opened empty for every test</summary>',
    '    private SqlUnitOfWork uow = null!;',
    '',
    '    public async ValueTask InitializeAsync()',
    '    {',
    '        db = await TestDatabase.OpenAsync();',
    caller && '        // The caller owns the transaction: the test opens it, and it ends with the test',
    caller && '        await db.BeginAsync();',
    '        uow = new SqlUnitOfWork(db);',
    '    }',
    '',
    '    public async ValueTask DisposeAsync() => await db.DisposeAsync();',
  ]
}

export const sqlOrm: CsharpOrm = {
  id: 'sql',
  holder: 'Db',
  // Nothing is kept between reads
  forget: null,
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}"' : '"[]"'),
  databaseFiles: sqlDatabaseFiles,
  entityFile: sqlEntityFile,
  repository: {
    usings: [],
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, with SQL through ADO.NET. ${
        context.settings.transactions === 'caller'
          ? 'Writes run in the transaction of whoever holds the Db, when there is one.'
          : 'A write joins the transaction already open, or is committed at once.'
      }`,
    head: sqlHead,
    body: sqlBody,
    tail: sqlTail,
  },
  transaction: [
    '// Joins the transaction already open',
    'if (Db.InTransaction) return await work(this);',
    'await Db.BeginAsync();',
    'try',
    '{',
    '    var result = await work(this);',
    '    await Db.CommitAsync();',
    '    return result;',
    '}',
    'catch',
    '{',
    '    await Db.RollbackAsync();',
    '    throw;',
    '}',
  ],
  testDatabaseFiles: (context) => [testDatabaseFile(context), databaseTestsFile(context)],
  testMembers,
  // The ADO.NET driver of the database is all it needs
  packages: (context) => [DRIVERS[context.settings.database] ?? DRIVERS.postgresql],
  readme: {
    intro: 'plain entities, repositories with their own SQL through ADO.NET and services',
    layout: [
      'src/App/Database.cs              opens the database DATABASE_CONNECTION names',
      'src/App/Db.cs                    one connection and its transaction, and how the repositories run SQL on it',
    ],
    reset: 'its tables are dropped and created again',
  },
}
