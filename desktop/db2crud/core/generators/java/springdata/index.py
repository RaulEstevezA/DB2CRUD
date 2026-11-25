"""Java 21 + Spring Data MongoDB (Strategy of the Java generator): entities mapped as the documents are, repositories over
a MongoTemplate, a unit of work over its transactions, and tests on a database made empty for each one. Only the library
is used: no Spring application is needed. Mirrors web/src/core/generators/java/springdata/index.ts."""

from ...types import lines
from ..context import errors_package, package_of, repository_type, sql_repository_class
from ..java import JavaImports, java_path
from ..project import dependency
from ..support import file
from .entities import entity_file
from .repository import CORE, body, head, tail

VERSIONS = {"springData": "5.1.3", "driver": "5.8.1"}


def _listed(classes) -> list[str]:
    """The classes of the documents in lists of some nested classes."""
    return [
        path for item in classes for path in [*([item["path"]] if item["listed"] else []), *_listed(item["classes"])]
    ]


def _items_of(context: dict) -> list[str]:
    return [path for info in context["tables"] for path in _listed(info["nested"].values())]


def _item_converter_file(context: dict) -> dict:
    pkg = context["base"]
    items = _items_of(context)
    imports = JavaImports(pkg).add(
        "java.util.Collections",
        "java.util.Map",
        "java.util.Set",
        "java.util.WeakHashMap",
        "org.bson.Document",
        "org.bson.conversions.Bson",
        "org.springframework.data.core.TypeInformation",
        f"{CORE}.convert.MappingMongoConverter",
        f"{CORE}.convert.NoOpDbRefResolver",
        f"{CORE}.mapping.MongoMappingContext",
        f"{CORE}.mapping.MongoPersistentEntity",
        f"{CORE}.mapping.MongoPersistentProperty",
    )
    for info in context["tables"]:
        if _listed(info["nested"].values()):
            imports.add(f"{package_of(context, info, 'entity')}.{info['entity']}")
    return file(
        pkg,
        "ItemConverter",
        [
            "/** Keeps the fields the classes of the documents of lists do not know: lists are written whole, and would lose them. */",
            "class ItemConverter extends MappingMongoConverter {",
            f"    private static final Set<Class<?>> ITEMS = Set.of({', '.join(f'{item}.class' for item in items)});",
            "",
            "    /** The fields each item was read with that its class does not know */",
            "    private static final Map<Object, Document> OTHERS = Collections.synchronizedMap(new WeakHashMap<>());",
            "",
            "    ItemConverter(MongoMappingContext mapping) {",
            "        super(NoOpDbRefResolver.INSTANCE, mapping);",
            "    }",
            "",
            "    @Override",
            "    protected <S> S readDocument(ConversionContext context, Bson bson, TypeInformation<? extends S> type) {",
            "        S item = super.readDocument(context, bson, type);",
            "        if (item != null && ITEMS.contains(item.getClass()) && bson instanceof Document document) {",
            "            Document others = new Document(document);",
            "            for (MongoPersistentProperty property : getMappingContext().getRequiredPersistentEntity(item.getClass())) {",
            "                others.remove(property.getFieldName());",
            "            }",
            "            if (!others.isEmpty()) OTHERS.put(item, others);",
            "        }",
            "        return item;",
            "    }",
            "",
            "    @Override",
            "    protected void writeInternal(Object item, Bson bson, MongoPersistentEntity<?> entity) {",
            "        super.writeInternal(item, bson, entity);",
            "        if (item != null && ITEMS.contains(item.getClass()) && bson instanceof Document document) {",
            "            Document others = OTHERS.get(item);",
            "            if (others != null) others.forEach(document::putIfAbsent);",
            "        }",
            "    }",
            "}",
        ],
        imports,
    )


def _database_file(context: dict) -> dict:
    pkg = context["base"]
    imports = JavaImports(pkg).add(
        "com.mongodb.ConnectionString",
        "com.mongodb.MongoClientSettings",
        "com.mongodb.client.MongoClient",
        "com.mongodb.client.MongoClients",
        "java.util.List",
        "org.bson.UuidRepresentation",
        f"{CORE}.MongoTemplate",
        f"{CORE}.SimpleMongoClientDatabaseFactory",
        f"{CORE}.convert.DefaultMongoTypeMapper",
        f"{CORE}.convert.MappingMongoConverter",
        f"{CORE}.convert.MongoCustomConversions",
        f"{CORE}.mapping.MongoMappingContext",
    )
    items = len(_items_of(context)) > 0
    if not items:
        imports.add(f"{CORE}.convert.NoOpDbRefResolver")
    for info in context["tables"]:
        imports.add(f"{package_of(context, info, 'entity')}.{info['entity']}")
    converter = "ItemConverter(mapping)" if items else "MappingMongoConverter(NoOpDbRefResolver.INSTANCE, mapping)"
    entities = ", ".join(f"{info['entity']}.class" for info in context["tables"])
    return file(
        pkg,
        "Database",
        [
            "/** The MongoDB database DATABASE_URL names, through Spring Data. It creates no collection and no index: the database already exists. */",
            "public final class Database {",
            '    public static final String DEFAULT_URL = "mongodb://localhost:27017/app";',
            "",
            "    /** Every entity, one per collection */",
            f"    public static final List<Class<?>> ENTITIES = List.of({entities});",
            "",
            "    private Database() {}",
            "",
            "    /** A client for the server at url, which keeps UUIDs as the standard says; close it when the application ends. */",
            "    public static MongoClient client(String url) {",
            "        return MongoClients.create(MongoClientSettings.builder()",
            "                .applyConnectionString(new ConnectionString(url))",
            "                .uuidRepresentation(UuidRepresentation.STANDARD)",
            "                .build());",
            "    }",
            "",
            "    /** The template of a database of the client. */",
            "    public static MongoTemplate template(MongoClient client, String database) {",
            "        MongoCustomConversions conversions = MongoCustomConversions.create((adapter) -> adapter",
            "                .bigDecimal(MongoCustomConversions.BigDecimalRepresentation.DECIMAL128));",
            "        MongoMappingContext mapping = new MongoMappingContext();",
            "        mapping.setSimpleTypeHolder(conversions.getSimpleTypeHolder());",
            "        mapping.afterPropertiesSet();",
            f"        MappingMongoConverter converter = new {converter};",
            "        converter.setCustomConversions(conversions);",
            "        // Documents hold no name of a Java class",
            "        converter.setTypeMapper(new DefaultMongoTypeMapper(null));",
            "        converter.afterPropertiesSet();",
            "        return new MongoTemplate(new SimpleMongoClientDatabaseFactory(client, database), converter);",
            "    }",
            "",
            "    /** The template of the database DATABASE_URL names. */",
            "    public static MongoTemplate open() {",
            '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
            "        return template(client(url), new ConnectionString(url).getDatabase());",
            "    }",
            "}",
        ],
        imports,
    )


def _documents_file(context: dict) -> dict:
    pkg = context["base"]
    return file(
        pkg,
        "Documents",
        [
            "/** Entities as the documents they are stored as, and what changed in them. */",
            "public final class Documents {",
            "    private Documents() {}",
            "",
            "    /** The document of an entity, or of a nested one. */",
            "    public static Document of(MongoTemplate mongo, Object entity) {",
            "        Document document = new Document();",
            "        mongo.getConverter().write(entity, document);",
            "        return document;",
            "    }",
            "",
            "    /** The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own. */",
            "    public static Document changes(Document before, Document now, List<String> fields) {",
            "        Document set = new Document();",
            "        Document unset = new Document();",
            '        for (String field : fields) compare("", field, before == null ? null : before.get(field), now.get(field), set, unset);',
            "        Document result = new Document();",
            '        if (!set.isEmpty()) result.append("$set", set);',
            '        if (!unset.isEmpty()) result.append("$unset", unset);',
            "        return result;",
            "    }",
            "",
            "    /** The domain error of a refused write: a repeated value, or one the validator of the collection does not take. */",
            "    public static RuntimeException refusal(String entity, DataAccessException error) {",
            "        boolean refused = error instanceof DataIntegrityViolationException",
            "                || error.getCause() instanceof MongoException cause && cause.getCode() == 121;",
            '        return refused ? new ConflictException(entity, "the database refused the change: " + error.getMessage()) : error;',
            "    }",
            "",
            "    private static void compare(String path, String field, Object before, Object now, Document set, Document unset) {",
            "        String name = path + field;",
            "        if (Objects.deepEquals(before, now)) return;",
            '        if (now == null) unset.append(name, "");',
            "        else if (before instanceof Document old && now instanceof Document current) {",
            "            Set<String> names = new LinkedHashSet<>(old.keySet());",
            "            names.addAll(current.keySet());",
            '            for (String item : names) compare(name + ".", item, old.get(item), current.get(item), set, unset);',
            "        } else set.append(name, now);",
            "    }",
            "}",
        ],
        JavaImports(pkg).add(
            f"{errors_package(context)}.ConflictException",
            "java.util.LinkedHashSet",
            "java.util.List",
            "java.util.Objects",
            "java.util.Set",
            "org.bson.Document",
            "org.springframework.dao.DataAccessException",
            "org.springframework.dao.DataIntegrityViolationException",
            "com.mongodb.MongoException",
            f"{CORE}.MongoTemplate",
        ),
    )


def _unit_of_work(context: dict, imports: JavaImports, accessors: list[str]) -> list[str]:
    tables = context["tables"]
    operation = context["settings"]["transactions"] == "operation"
    imports.add(f"{CORE}.MongoTemplate")
    if operation:
        imports.add(
            "org.springframework.data.mongodb.MongoTransactionManager",
            "org.springframework.transaction.support.TransactionTemplate",
        )
        transaction = [
            "        // Joins the transaction already open",
            "        return transactions.execute((status) -> work.apply(this));",
        ]
    else:
        transaction = ["        return work.apply(this);"]
    also = ", and its transactions: MongoDB has them on replica sets only" if operation else ""
    return [
        f"/** The repositories over one MongoTemplate{also}. */",
        "public class SqlUnitOfWork implements UnitOfWork {",
        "    private final MongoTemplate mongo;",
        *(["    private final TransactionTemplate transactions;"] if operation else []),
        *(f"    private final {repository_type(context, info)} {info['attr']};" for info in tables),
        "",
        "    public SqlUnitOfWork(MongoTemplate mongo) {",
        "        this.mongo = mongo;",
        *(
            [
                "        this.transactions = new TransactionTemplate(new MongoTransactionManager(mongo.getMongoDatabaseFactory()));"
            ]
            if operation
            else []
        ),
        *(f"        this.{info['attr']} = new {sql_repository_class(info)}(mongo);" for info in tables),
        "    }",
        "",
        "    public MongoTemplate mongo() {",
        "        return mongo;",
        "    }",
        *accessors,
        "",
        "    @Override",
        "    public <T> T transaction(Function<UnitOfWork, T> work) {",
        *transaction,
        "    }",
        "}",
    ]


def _test_database_files(context: dict) -> list[dict]:
    pkg = context["base"]
    imports = JavaImports(pkg).add(
        "com.mongodb.ConnectionString",
        f"{CORE}.MongoTemplate",
        f"{CORE}.index.MongoPersistentEntityIndexResolver",
    )
    database = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        "/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test. */",
        "final class TestDatabase {",
        '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        "",
        "    private static MongoTemplate mongo;",
        "",
        "    private TestDatabase() {}",
        "",
        "    /** The template of the test database, with its collections and their indexes created again. */",
        "    static synchronized MongoTemplate open() {",
        "        if (URL == null)",
        '            throw new IllegalStateException("The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)");',
        "        if (mongo == null) mongo = Database.template(Database.client(URL), new ConnectionString(URL).getDatabase());",
        "        mongo.getDb().drop();",
        "        var resolver = new MongoPersistentEntityIndexResolver(mongo.getConverter().getMappingContext());",
        "        for (Class<?> entity : Database.ENTITIES) {",
        "            mongo.createCollection(entity);",
        "            resolver.resolveIndexFor(entity).forEach((index) -> mongo.indexOps(entity).createIndex(index));",
        "        }",
        "        return mongo;",
        "    }",
        "}",
        "",
    )
    test = lines(
        f"package {pkg};",
        "",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "",
        "import com.mongodb.ConnectionString;",
        "import org.junit.jupiter.api.Test;",
        "",
        "/** The tests run on the database they were asked to. */",
        "class DatabaseTest {",
        "    @Test",
        "    void isTheOneTestDatabaseUrlNames() {",
        "        assertEquals(new ConnectionString(TestDatabase.URL).getDatabase(), TestDatabase.open().getDb().getName());",
        "    }",
        "}",
        "",
    )
    return [
        {"path": java_path(pkg, "TestDatabase", True), "content": database},
        {"path": java_path(pkg, "DatabaseTest", True), "content": test},
    ]


def _test_session(context: dict, imports: JavaImports) -> list:
    imports.add("org.junit.jupiter.api.BeforeEach")
    return [
        "    /** The repositories over the test database, opened empty for every test */",
        "    private SqlUnitOfWork uow;",
        "",
        "    @BeforeEach",
        "    void open() {",
        "        uow = new SqlUnitOfWork(TestDatabase.open());",
        "    }",
    ]


def _doc(context: dict, info: dict) -> str:
    how = (
        "Every write is stored at once."
        if context["settings"]["transactions"] == "repository"
        else "It runs in the transaction already open, when there is one."
    )
    return f"Keeps {info['name']} documents in the database, through a MongoTemplate. {how}"


SPRING_DATA_ORM = {
    "id": "springdata",
    "holder": "MongoTemplate",
    "documents": True,
    "ownModels": True,
    "prefix": "Mongo",
    "url": "mongodb://localhost:27017/app",
    "forget": None,
    "emptyList": lambda context: "new java.util.ArrayList<>()",
    "databaseFiles": lambda context: [
        _database_file(context),
        _documents_file(context),
        *([_item_converter_file(context)] if _items_of(context) else []),
    ],
    "entityFile": entity_file,
    "repository": {"doc": _doc, "head": head, "body": body, "tail": tail},
    "unitOfWork": _unit_of_work,
    "testDatabaseFiles": _test_database_files,
    "testSession": _test_session,
    "dependencies": lambda context: [
        *dependency("org.springframework.data", "spring-data-mongodb", VERSIONS["springData"]),
        *dependency("org.mongodb", "mongodb-driver-sync", VERSIONS["driver"]),
    ],
    "readme": {
        "intro": "entities, repositories and services with Spring Data MongoDB",
        "layout": lambda context: [
            f"src/main/java/{context['base']}/Database.java        the MongoTemplate of DATABASE_URL",
            f"src/main/java/{context['base']}/Documents.java       entities as documents, and what changed in them",
        ],
        "note": "`Database.open()` makes one client for the application. In a Spring application, inject its own `MongoTemplate` into `MongoUnitOfWork` instead; transactions need a replica set.",
    },
}
