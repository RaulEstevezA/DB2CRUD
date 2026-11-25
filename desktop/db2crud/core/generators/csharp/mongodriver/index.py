"""C# + the official MongoDB driver (Strategy of orm.ts): entities mapped as the documents are, repositories over Db (the
database and the session of its transaction), and tests on a database made empty for each one. Mirrors
web/src/core/generators/csharp/mongodriver/index.ts."""

from ..context import errors_namespace
from ..csharp import CsUsings, cs_string
from ..support import default_connection, file
from ..tests import test_file, tests_ns
from .entities import entity_file
from .repository import body, head, tail

_VERSION = "3.14.1"


def _database_file(context: dict) -> dict:
    return file(
        context["base"],
        "Database",
        [
            "/// <summary>The MongoDB database DATABASE_CONNECTION names. It creates no collection and no index: the database already exists.</summary>",
            "public static class Database",
            "{",
            f'    public const string DefaultConnection = "{default_connection(context)}";',
            "",
            "    /// <summary>One client for the whole application: it keeps the connections.</summary>",
            "    private static readonly Lazy<IMongoDatabase> Shared = new(() => At(Connection));",
            "",
            "    /// <summary>The connection string of DATABASE_CONNECTION, or the default one.</summary>",
            '    public static string Connection => Environment.GetEnvironmentVariable("DATABASE_CONNECTION") ?? DefaultConnection;',
            "",
            "    /// <summary>The database a connection string names, with a client of its own.</summary>",
            "    public static IMongoDatabase At(string connection)",
            "    {",
            "        var url = new MongoUrl(connection);",
            "        return new MongoClient(url).GetDatabase(url.DatabaseName);",
            "    }",
            "",
            "    /// <summary>A Db over DATABASE_CONNECTION, one per unit of work; dispose it when done.</summary>",
            "    public static Db Open() => new(Shared.Value);",
            "}",
        ],
        CsUsings(context["base"]).add("MongoDB.Driver"),
    )


def _db_file(context: dict) -> dict:
    """`Db`: the database and its session, and how the repositories reach its collections."""
    return file(
        context["base"],
        "Db",
        [
            "/// <summary>A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused write is a ConflictException.</summary>",
            "public sealed class Db(IMongoDatabase database) : IAsyncDisposable",
            "{",
            "    private IClientSessionHandle? session;",
            "",
            "    public IMongoDatabase Database { get; } = database;",
            "",
            "    public bool InTransaction => session is not null;",
            "",
            "    public async Task BeginAsync()",
            "    {",
            "        session = await Database.Client.StartSessionAsync();",
            "        session.StartTransaction();",
            "    }",
            "",
            "    public async Task CommitAsync()",
            "    {",
            "        await session!.CommitTransactionAsync();",
            "        End();",
            "    }",
            "",
            "    public async Task RollbackAsync()",
            "    {",
            "        if (session is { IsInTransaction: true }) await session.AbortTransactionAsync();",
            "        End();",
            "    }",
            "",
            "    public async ValueTask DisposeAsync() => await RollbackAsync();",
            "",
            "    private void End()",
            "    {",
            "        session?.Dispose();",
            "        session = null;",
            "    }",
            "",
            "    public IFindFluent<T, T> Find<T>(string collection, FilterDefinition<T> filter) =>",
            "        session is null ? Database.GetCollection<T>(collection).Find(filter) : Database.GetCollection<T>(collection).Find(session, filter);",
            "",
            "    public Task<long> CountAsync<T>(string collection, FilterDefinition<T> filter) => Find(collection, filter).CountDocumentsAsync();",
            "",
            "    public Task InsertAsync<T>(string entity, string collection, T document) =>",
            "        RefusedAsync(entity, async () =>",
            "        {",
            "            if (session is null) await Database.GetCollection<T>(collection).InsertOneAsync(document);",
            "            else await Database.GetCollection<T>(collection).InsertOneAsync(session, document);",
            "            return true;",
            "        });",
            "",
            "    public Task UpdateAsync<T>(string entity, string collection, FilterDefinition<T> filter, UpdateDefinition<T> change) =>",
            "        RefusedAsync(entity, () => session is null",
            "            ? Database.GetCollection<T>(collection).UpdateOneAsync(filter, change)",
            "            : Database.GetCollection<T>(collection).UpdateOneAsync(session, filter, change));",
            "",
            "    public Task DeleteAsync<T>(string entity, string collection, FilterDefinition<T> filter) =>",
            "        RefusedAsync(entity, () => session is null",
            "            ? Database.GetCollection<T>(collection).DeleteOneAsync(filter)",
            "            : Database.GetCollection<T>(collection).DeleteOneAsync(session, filter));",
            "",
            "    /// <summary>Changes one document where it is, and gives it as it is then; null when there is none.</summary>",
            "    public Task<T?> ChangeAsync<T>(string entity, string collection, FilterDefinition<T> filter, UpdateDefinition<T> change) where T : class",
            "    {",
            "        var after = new FindOneAndUpdateOptions<T, T?> { ReturnDocument = ReturnDocument.After };",
            "        return RefusedAsync(entity, () => session is null",
            "            ? Database.GetCollection<T>(collection).FindOneAndUpdateAsync(filter, change, after)",
            "            : Database.GetCollection<T>(collection).FindOneAndUpdateAsync(session, filter, change, after));",
            "    }",
            "",
            "    /// <summary>The same, with the stages of a pipeline.</summary>",
            "    public Task<T?> ChangeAsync<T>(string entity, string collection, FilterDefinition<T> filter, BsonDocument[] stages) where T : class =>",
            "        ChangeAsync(entity, collection, filter, Builders<T>.Update.Pipeline(stages));",
            "",
            "    /// <summary>A repeated value, or one the validator of the collection does not take, as a domain error.</summary>",
            "    private static async Task<TResult> RefusedAsync<TResult>(string entity, Func<Task<TResult>> work)",
            "    {",
            "        try",
            "        {",
            "            return await work();",
            "        }",
            "        catch (MongoWriteException error) when (error.WriteError is { } refusal && (refusal.Category == ServerErrorCategory.DuplicateKey || refusal.Code == 121))",
            "        {",
            '            throw new ConflictException(entity, $"the database refused the change: {error.Message}");',
            "        }",
            "        catch (MongoCommandException error) when (error.Code is 11000 or 121)",
            "        {",
            '            throw new ConflictException(entity, $"the database refused the change: {error.Message}");',
            "        }",
            "    }",
            "}",
        ],
        CsUsings(context["base"]).add("MongoDB.Bson", "MongoDB.Driver", errors_namespace(context)),
    )


def _documents_file(context: dict) -> dict:
    return file(
        context["base"],
        "Documents",
        [
            "/// <summary>What changed in a document.</summary>",
            "public static class Documents",
            "{",
            "    /// <summary>The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own.</summary>",
            "    public static BsonDocument Changes(BsonDocument? before, BsonDocument now, IEnumerable<string> fields)",
            "    {",
            "        var set = new BsonDocument();",
            "        var unset = new BsonDocument();",
            '        foreach (var field in fields) Compare("", field, before, now, set, unset);',
            "        var result = new BsonDocument();",
            '        if (set.ElementCount > 0) result["$set"] = set;',
            '        if (unset.ElementCount > 0) result["$unset"] = unset;',
            "        return result;",
            "    }",
            "",
            "    private static void Compare(string path, string field, BsonDocument? before, BsonDocument now, BsonDocument set, BsonDocument unset)",
            "    {",
            "        var old = before?.GetValue(field, null);",
            "        var current = now.GetValue(field, null);",
            "        if (Equals(old, current)) return;",
            "        var name = path + field;",
            '        if (current is null) unset[name] = "";',
            "        else if (old is BsonDocument was && current is BsonDocument document)",
            '            foreach (var item in was.Names.Union(document.Names).ToList()) Compare(name + ".", item, was, document, set, unset);',
            "        else set[name] = current;",
            "    }",
            "}",
        ],
        CsUsings(context["base"]).add("MongoDB.Bson"),
    )


def _index_line(info: dict, item: dict, unique: bool) -> str:
    """An index of a collection, for the tests."""
    nullable = {column["name"] for column in info["table"]["columns"] if column["nullable"]}
    options = []
    if item.get("name"):
        options.append(f"Name = {cs_string(item['name'])}")
    if unique:
        options.append("Unique = true")
        if all(column in nullable for column in item["columns"]):
            options.append("Sparse = true")
    keys = ", ".join(f"[{cs_string(column)}] = 1" for column in item["columns"])
    given = f", new CreateIndexOptions {{ {', '.join(options)} }}" if options else ""
    collection = f"database.GetCollection<BsonDocument>({cs_string(info['name'])})"
    model = f"new CreateIndexModel<BsonDocument>(new BsonDocument {{ {keys} }}{given})"
    return f"        await {collection}.Indexes.CreateOneAsync({model});"


def _index_lines(context: dict) -> list[str]:
    result = []
    for info in context["tables"]:
        result += [_index_line(info, item, True) for item in info["table"]["uniques"]]
        result += [_index_line(info, item, False) for item in info["table"]["indexes"]]
    return result


def _test_database_files(context: dict) -> list[dict]:
    indexes = _index_lines(context)
    usings = CsUsings(tests_ns(context)).add(context["base"], "MongoDB.Driver")
    if indexes:
        usings.add("MongoDB.Bson")
    return [
        test_file(
            context,
            "TestDatabase",
            usings,
            [
                "/// <summary>The test database: the MongoDB database TEST_DATABASE_CONNECTION names, with every collection created empty before every test.</summary>",
                "internal static class TestDatabase",
                "{",
                '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
                "",
                "    private static IMongoDatabase? shared;",
                "",
                "    /// <summary>The test database, with its collections and their indexes created again.</summary>",
                "    public static async Task<Db> OpenAsync()",
                "    {",
                "        if (Connection is null)",
                '            throw new InvalidOperationException("The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_CONNECTION (it is emptied)");',
                "        var database = shared ??= Database.At(Connection);",
                "        await database.Client.DropDatabaseAsync(database.DatabaseNamespace.DatabaseName);",
                *(
                    f"        await database.CreateCollectionAsync({cs_string(info['name'])});"
                    for info in context["tables"]
                ),
                *indexes,
                "        return new Db(database);",
                "    }",
                "}",
            ],
        ),
        test_file(
            context,
            "DatabaseTests",
            CsUsings(tests_ns(context)).add("MongoDB.Driver", "Xunit"),
            [
                "/// <summary>The tests run on the database they were asked to.</summary>",
                "public class DatabaseTests",
                "{",
                "    [Fact]",
                "    public async Task IsTheOneTestDatabaseConnectionNames()",
                "    {",
                "        await using var db = await TestDatabase.OpenAsync();",
                "        Assert.Equal(new MongoUrl(TestDatabase.Connection).DatabaseName, db.Database.DatabaseNamespace.DatabaseName);",
                "    }",
                "}",
            ],
        ),
    ]


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
        " Every write is stored at once."
        if context["settings"]["transactions"] == "repository"
        else " It runs in the transaction already open, when there is one."
    )
    return f"Keeps {info['name']} documents in the database, through the MongoDB driver.{how}"


MONGO_DRIVER_ORM = {
    "id": "mongodriver",
    "holder": "Db",
    "documents": True,
    "prefix": "Mongo",
    # Nothing is kept between reads but what each entity was
    "forget": None,
    "emptyList": lambda _context: "[]",
    "databaseFiles": lambda context: [_database_file(context), _db_file(context), _documents_file(context)],
    "entityFile": entity_file,
    "repository": {"usings": ["MongoDB.Bson", "MongoDB.Driver"], "doc": _doc, "head": head, "body": body, "tail": tail},
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
    "testDatabaseFiles": _test_database_files,
    "testMembers": _test_members,
    "packages": lambda _context: [("MongoDB.Driver", _VERSION)],
    "readme": {
        "intro": "entities, repositories and services with the MongoDB driver",
        "layout": [
            "src/App/Database.cs              opens the database DATABASE_CONNECTION names",
            "src/App/Db.cs                    a database and the session of its transaction",
            "src/App/Documents.cs             what changed in a document",
        ],
        "reset": "it is dropped and created again; transactions need a replica set",
    },
}
