/**
 * C# + the official MongoDB driver (Strategy of orm.ts): entities mapped as the documents are, repositories over Db (the
 * database and the session of its transaction), and tests on a database made empty for each one.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Line } from '../../types.ts'
import { csString, CsUsings } from '../csharp.ts'
import { errorsNamespace, type Context } from '../context.ts'
import type { CsharpOrm } from '../orm.ts'
import { defaultConnection, file } from '../support.ts'
import { testFile, testsNs } from '../tests.ts'
import { entityFile } from './entities.ts'
import { body, head, tail } from './repository.ts'

const VERSION = '3.14.1'

function databaseFile(context: Context): GeneratedFile {
  return file(
    context.base,
    'Database',
    [
      '/// <summary>The MongoDB database DATABASE_CONNECTION names. It creates no collection and no index: the database already exists.</summary>',
      'public static class Database',
      '{',
      `    public const string DefaultConnection = "${defaultConnection(context)}";`,
      '',
      '    /// <summary>One client for the whole application: it keeps the connections.</summary>',
      '    private static readonly Lazy<IMongoDatabase> Shared = new(() => At(Connection));',
      '',
      '    /// <summary>The connection string of DATABASE_CONNECTION, or the default one.</summary>',
      '    public static string Connection => Environment.GetEnvironmentVariable("DATABASE_CONNECTION") ?? DefaultConnection;',
      '',
      '    /// <summary>The database a connection string names, with a client of its own.</summary>',
      '    public static IMongoDatabase At(string connection)',
      '    {',
      '        var url = new MongoUrl(connection);',
      '        return new MongoClient(url).GetDatabase(url.DatabaseName);',
      '    }',
      '',
      '    /// <summary>A Db over DATABASE_CONNECTION, one per unit of work; dispose it when done.</summary>',
      '    public static Db Open() => new(Shared.Value);',
      '}',
    ],
    new CsUsings(context.base).add('MongoDB.Driver'),
  )
}

/** `Db`: the database and its session, and how the repositories reach its collections. */
function dbFile(context: Context): GeneratedFile {
  return file(
    context.base,
    'Db',
    [
      '/// <summary>A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused write is a ConflictException.</summary>',
      'public sealed class Db(IMongoDatabase database) : IAsyncDisposable',
      '{',
      '    private IClientSessionHandle? session;',
      '',
      '    public IMongoDatabase Database { get; } = database;',
      '',
      '    public bool InTransaction => session is not null;',
      '',
      '    public async Task BeginAsync()',
      '    {',
      '        session = await Database.Client.StartSessionAsync();',
      '        session.StartTransaction();',
      '    }',
      '',
      '    public async Task CommitAsync()',
      '    {',
      '        await session!.CommitTransactionAsync();',
      '        End();',
      '    }',
      '',
      '    public async Task RollbackAsync()',
      '    {',
      '        if (session is { IsInTransaction: true }) await session.AbortTransactionAsync();',
      '        End();',
      '    }',
      '',
      '    public async ValueTask DisposeAsync() => await RollbackAsync();',
      '',
      '    private void End()',
      '    {',
      '        session?.Dispose();',
      '        session = null;',
      '    }',
      '',
      '    public IFindFluent<T, T> Find<T>(string collection, FilterDefinition<T> filter) =>',
      '        session is null ? Database.GetCollection<T>(collection).Find(filter) : Database.GetCollection<T>(collection).Find(session, filter);',
      '',
      '    public Task<long> CountAsync<T>(string collection, FilterDefinition<T> filter) => Find(collection, filter).CountDocumentsAsync();',
      '',
      '    public Task InsertAsync<T>(string entity, string collection, T document) =>',
      '        RefusedAsync(entity, async () =>',
      '        {',
      '            if (session is null) await Database.GetCollection<T>(collection).InsertOneAsync(document);',
      '            else await Database.GetCollection<T>(collection).InsertOneAsync(session, document);',
      '            return true;',
      '        });',
      '',
      '    public Task UpdateAsync<T>(string entity, string collection, FilterDefinition<T> filter, UpdateDefinition<T> change) =>',
      '        RefusedAsync(entity, () => session is null',
      '            ? Database.GetCollection<T>(collection).UpdateOneAsync(filter, change)',
      '            : Database.GetCollection<T>(collection).UpdateOneAsync(session, filter, change));',
      '',
      '    public Task DeleteAsync<T>(string entity, string collection, FilterDefinition<T> filter) =>',
      '        RefusedAsync(entity, () => session is null',
      '            ? Database.GetCollection<T>(collection).DeleteOneAsync(filter)',
      '            : Database.GetCollection<T>(collection).DeleteOneAsync(session, filter));',
      '',
      '    /// <summary>Changes one document where it is, and gives it as it is then; null when there is none.</summary>',
      '    public Task<T?> ChangeAsync<T>(string entity, string collection, FilterDefinition<T> filter, UpdateDefinition<T> change) where T : class',
      '    {',
      '        var after = new FindOneAndUpdateOptions<T, T?> { ReturnDocument = ReturnDocument.After };',
      '        return RefusedAsync(entity, () => session is null',
      '            ? Database.GetCollection<T>(collection).FindOneAndUpdateAsync(filter, change, after)',
      '            : Database.GetCollection<T>(collection).FindOneAndUpdateAsync(session, filter, change, after));',
      '    }',
      '',
      '    /// <summary>The same, with the stages of a pipeline.</summary>',
      '    public Task<T?> ChangeAsync<T>(string entity, string collection, FilterDefinition<T> filter, BsonDocument[] stages) where T : class =>',
      '        ChangeAsync(entity, collection, filter, Builders<T>.Update.Pipeline(stages));',
      '',
      '    /// <summary>A repeated value, or one the validator of the collection does not take, as a domain error.</summary>',
      '    private static async Task<TResult> RefusedAsync<TResult>(string entity, Func<Task<TResult>> work)',
      '    {',
      '        try',
      '        {',
      '            return await work();',
      '        }',
      '        catch (MongoWriteException error) when (error.WriteError is { } refusal && (refusal.Category == ServerErrorCategory.DuplicateKey || refusal.Code == 121))',
      '        {',
      '            throw new ConflictException(entity, $"the database refused the change: {error.Message}");',
      '        }',
      '        catch (MongoCommandException error) when (error.Code is 11000 or 121)',
      '        {',
      '            throw new ConflictException(entity, $"the database refused the change: {error.Message}");',
      '        }',
      '    }',
      '}',
    ],
    new CsUsings(context.base).add('MongoDB.Bson', 'MongoDB.Driver', errorsNamespace(context)),
  )
}

function documentsFile(context: Context): GeneratedFile {
  return file(
    context.base,
    'Documents',
    [
      '/// <summary>What changed in a document.</summary>',
      'public static class Documents',
      '{',
      '    /// <summary>The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own.</summary>',
      '    public static BsonDocument Changes(BsonDocument? before, BsonDocument now, IEnumerable<string> fields)',
      '    {',
      '        var set = new BsonDocument();',
      '        var unset = new BsonDocument();',
      '        foreach (var field in fields) Compare("", field, before, now, set, unset);',
      '        var result = new BsonDocument();',
      '        if (set.ElementCount > 0) result["$set"] = set;',
      '        if (unset.ElementCount > 0) result["$unset"] = unset;',
      '        return result;',
      '    }',
      '',
      '    private static void Compare(string path, string field, BsonDocument? before, BsonDocument now, BsonDocument set, BsonDocument unset)',
      '    {',
      '        var old = before?.GetValue(field, null);',
      '        var current = now.GetValue(field, null);',
      '        if (Equals(old, current)) return;',
      '        var name = path + field;',
      '        if (current is null) unset[name] = "";',
      '        else if (old is BsonDocument was && current is BsonDocument document)',
      '            foreach (var item in was.Names.Union(document.Names).ToList()) Compare(name + ".", item, was, document, set, unset);',
      '        else set[name] = current;',
      '    }',
      '}',
    ],
    new CsUsings(context.base).add('MongoDB.Bson'),
  )
}

/** An index of a collection, for the tests. */
function indexLines(context: Context): string[] {
  return context.tables.flatMap((info) => {
    const nullable = (columns: string[]) => columns.every((name) => info.table.columns.find((column) => column.name === name)?.nullable)
    const index = (item: { name?: string; columns: string[] }, unique: boolean) => {
      const options = [
        ...(item.name ? [`Name = ${csString(item.name)}`] : []),
        ...(unique ? ['Unique = true'] : []),
        ...(unique && nullable(item.columns) ? ['Sparse = true'] : []),
      ]
      const keys = item.columns.map((column) => `[${csString(column)}] = 1`).join(', ')
      return `        await database.GetCollection<BsonDocument>(${csString(info.name)}).Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(new BsonDocument { ${keys} }${options.length > 0 ? `, new CreateIndexOptions { ${options.join(', ')} }` : ''}));`
    }
    return [...info.table.uniques.map((item) => index(item, true)), ...info.table.indexes.map((item) => index(item, false))]
  })
}

function testDatabaseFiles(context: Context): GeneratedFile[] {
  const indexes = indexLines(context)
  const usings = new CsUsings(testsNs(context)).add(context.base, 'MongoDB.Driver')
  if (indexes.length > 0) usings.add('MongoDB.Bson')
  return [
    testFile(context, 'TestDatabase', usings, [
      '/// <summary>The test database: the MongoDB database TEST_DATABASE_CONNECTION names, with every collection created empty before every test.</summary>',
      'internal static class TestDatabase',
      '{',
      '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
      '',
      '    private static IMongoDatabase? shared;',
      '',
      '    /// <summary>The test database, with its collections and their indexes created again.</summary>',
      '    public static async Task<Db> OpenAsync()',
      '    {',
      '        if (Connection is null)',
      '            throw new InvalidOperationException("The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_CONNECTION (it is emptied)");',
      '        var database = shared ??= Database.At(Connection);',
      '        await database.Client.DropDatabaseAsync(database.DatabaseNamespace.DatabaseName);',
      ...context.tables.map((info) => `        await database.CreateCollectionAsync(${csString(info.name)});`),
      ...indexes,
      '        return new Db(database);',
      '    }',
      '}',
    ]),
    testFile(context, 'DatabaseTests', new CsUsings(testsNs(context)).add('MongoDB.Driver', 'Xunit'), [
      '/// <summary>The tests run on the database they were asked to.</summary>',
      'public class DatabaseTests',
      '{',
      '    [Fact]',
      '    public async Task IsTheOneTestDatabaseConnectionNames()',
      '    {',
      '        await using var db = await TestDatabase.OpenAsync();',
      '        Assert.Equal(new MongoUrl(TestDatabase.Connection).DatabaseName, db.Database.DatabaseNamespace.DatabaseName);',
      '    }',
      '}',
    ]),
  ]
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

export const mongoDriverOrm: CsharpOrm = {
  id: 'mongodriver',
  holder: 'Db',
  documents: true,
  prefix: 'Mongo',
  // Nothing is kept between reads but what each entity was
  forget: null,
  emptyList: () => '[]',
  databaseFiles: (context) => [databaseFile(context), dbFile(context), documentsFile(context)],
  entityFile,
  repository: {
    usings: ['MongoDB.Bson', 'MongoDB.Driver'],
    doc: (context, info) =>
      `Keeps ${info.name} documents in the database, through the MongoDB driver.${context.settings.transactions === 'repository' ? ' Every write is stored at once.' : ' It runs in the transaction already open, when there is one.'}`,
    head,
    body,
    tail,
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
  testDatabaseFiles,
  testMembers,
  packages: () => [['MongoDB.Driver', VERSION]],
  readme: {
    intro: 'entities, repositories and services with the MongoDB driver',
    layout: [
      'src/App/Database.cs              opens the database DATABASE_CONNECTION names',
      'src/App/Db.cs                    a database and the session of its transaction',
      'src/App/Documents.cs             what changed in a document',
    ],
    reset: 'it is dropped and created again; transactions need a replica set',
  },
}
