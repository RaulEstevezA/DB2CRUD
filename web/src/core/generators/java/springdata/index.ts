/**
 * Java 21 + Spring Data MongoDB (Strategy of orm.ts): entities mapped as the documents are, repositories over a
 * MongoTemplate, a unit of work over its transactions, and tests on a database made empty for each one. Only the library
 * is used: no Spring application is needed.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { javaPath, JavaImports } from '../java.ts'
import { errorsPackage, packageOf, repositoryType, sqlRepositoryClass, type Context } from '../context.ts'
import type { JavaOrm } from '../orm.ts'
import { dependency } from '../project.ts'
import { file } from '../support.ts'
import { entityFile } from './entities.ts'
import { body, head, tail } from './repository.ts'

const VERSIONS = { springData: '5.1.3', driver: '5.8.1' }

const CORE = 'org.springframework.data.mongodb.core'

function databaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  const imports = new JavaImports(pkg).add(
    'com.mongodb.ConnectionString',
    'com.mongodb.MongoClientSettings',
    'com.mongodb.client.MongoClient',
    'com.mongodb.client.MongoClients',
    'java.util.List',
    'org.bson.UuidRepresentation',
    `${CORE}.MongoTemplate`,
    `${CORE}.SimpleMongoClientDatabaseFactory`,
    `${CORE}.convert.DefaultMongoTypeMapper`,
    `${CORE}.convert.MappingMongoConverter`,
    `${CORE}.convert.MongoCustomConversions`,
    `${CORE}.convert.NoOpDbRefResolver`,
    `${CORE}.mapping.MongoMappingContext`,
  )
  for (const info of context.tables) imports.add(`${packageOf(context, info, 'entity')}.${info.entity}`)
  return file(
    pkg,
    'Database',
    [
      '/** The MongoDB database DATABASE_URL names, through Spring Data. It creates no collection and no index: the database already exists. */',
      'public final class Database {',
      '    public static final String DEFAULT_URL = "mongodb://localhost:27017/app";',
      '',
      '    /** Every entity, one per collection */',
      `    public static final List<Class<?>> ENTITIES = List.of(${context.tables.map((info) => `${info.entity}.class`).join(', ')});`,
      '',
      '    private Database() {}',
      '',
      '    /** A client for the server at url, which keeps UUIDs as the standard says; close it when the application ends. */',
      '    public static MongoClient client(String url) {',
      '        return MongoClients.create(MongoClientSettings.builder()',
      '                .applyConnectionString(new ConnectionString(url))',
      '                .uuidRepresentation(UuidRepresentation.STANDARD)',
      '                .build());',
      '    }',
      '',
      '    /** The template of a database of the client. */',
      '    public static MongoTemplate template(MongoClient client, String database) {',
      '        MongoCustomConversions conversions = MongoCustomConversions.create((adapter) -> adapter',
      '                .bigDecimal(MongoCustomConversions.BigDecimalRepresentation.DECIMAL128));',
      '        MongoMappingContext mapping = new MongoMappingContext();',
      '        mapping.setSimpleTypeHolder(conversions.getSimpleTypeHolder());',
      '        mapping.afterPropertiesSet();',
      '        MappingMongoConverter converter = new MappingMongoConverter(NoOpDbRefResolver.INSTANCE, mapping);',
      '        converter.setCustomConversions(conversions);',
      '        // Documents hold no name of a Java class',
      '        converter.setTypeMapper(new DefaultMongoTypeMapper(null));',
      '        converter.afterPropertiesSet();',
      '        return new MongoTemplate(new SimpleMongoClientDatabaseFactory(client, database), converter);',
      '    }',
      '',
      '    /** The template of the database DATABASE_URL names. */',
      '    public static MongoTemplate open() {',
      '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
      '        return template(client(url), new ConnectionString(url).getDatabase());',
      '    }',
      '}',
    ],
    imports,
  )
}

function documentsFile(context: Context): GeneratedFile {
  const pkg = context.base
  return file(
    pkg,
    'Documents',
    [
      '/** Entities as the documents they are stored as, and what changed in them. */',
      'public final class Documents {',
      '    private Documents() {}',
      '',
      '    /** The document of an entity, or of a nested one. */',
      '    public static Document of(MongoTemplate mongo, Object entity) {',
      '        Document document = new Document();',
      '        mongo.getConverter().write(entity, document);',
      '        return document;',
      '    }',
      '',
      '    /** The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own. */',
      '    public static Document changes(Document before, Document now, List<String> fields) {',
      '        Document set = new Document();',
      '        Document unset = new Document();',
      '        for (String field : fields) compare("", field, before == null ? null : before.get(field), now.get(field), set, unset);',
      '        Document result = new Document();',
      '        if (!set.isEmpty()) result.append("$set", set);',
      '        if (!unset.isEmpty()) result.append("$unset", unset);',
      '        return result;',
      '    }',
      '',
      '    /** The domain error of a refused write: a repeated value, or one the validator of the collection does not take. */',
      '    public static RuntimeException refusal(String entity, DataAccessException error) {',
      '        boolean refused = error instanceof DataIntegrityViolationException',
      '                || error.getCause() instanceof MongoException cause && cause.getCode() == 121;',
      '        return refused ? new ConflictException(entity, "the database refused the change: " + error.getMessage()) : error;',
      '    }',
      '',
      '    private static void compare(String path, String field, Object before, Object now, Document set, Document unset) {',
      '        String name = path + field;',
      '        if (Objects.deepEquals(before, now)) return;',
      '        if (now == null) unset.append(name, "");',
      '        else if (before instanceof Document old && now instanceof Document current) {',
      '            Set<String> names = new LinkedHashSet<>(old.keySet());',
      '            names.addAll(current.keySet());',
      '            for (String item : names) compare(name + ".", item, old.get(item), current.get(item), set, unset);',
      '        } else set.append(name, now);',
      '    }',
      '}',
    ],
    new JavaImports(pkg).add(
      `${errorsPackage(context)}.ConflictException`,
      'java.util.LinkedHashSet',
      'java.util.List',
      'java.util.Objects',
      'java.util.Set',
      'org.bson.Document',
      'org.springframework.dao.DataAccessException',
      'org.springframework.dao.DataIntegrityViolationException',
      'com.mongodb.MongoException',
      `${CORE}.MongoTemplate`,
    ),
  )
}

function unitOfWork(context: Context, imports: JavaImports, accessors: string[]): string[] {
  const operation = context.settings.transactions === 'operation'
  imports.add(`${CORE}.MongoTemplate`)
  if (operation)
    imports.add('org.springframework.data.mongodb.MongoTransactionManager', 'org.springframework.transaction.support.TransactionTemplate')
  return [
    `/** The repositories over one MongoTemplate${operation ? ', and its transactions: MongoDB has them on replica sets only' : ''}. */`,
    'public class SqlUnitOfWork implements UnitOfWork {',
    '    private final MongoTemplate mongo;',
    ...(operation ? ['    private final TransactionTemplate transactions;'] : []),
    ...context.tables.map((info) => `    private final ${repositoryType(context, info)} ${info.attr};`),
    '',
    '    public SqlUnitOfWork(MongoTemplate mongo) {',
    '        this.mongo = mongo;',
    ...(operation
      ? ['        this.transactions = new TransactionTemplate(new MongoTransactionManager(mongo.getMongoDatabaseFactory()));']
      : []),
    ...context.tables.map((info) => `        this.${info.attr} = new ${sqlRepositoryClass(info)}(mongo);`),
    '    }',
    '',
    '    public MongoTemplate mongo() {',
    '        return mongo;',
    '    }',
    ...accessors,
    '',
    '    @Override',
    '    public <T> T transaction(Function<UnitOfWork, T> work) {',
    ...(operation
      ? ['        // Joins the transaction already open', '        return transactions.execute((status) -> work.apply(this));']
      : ['        return work.apply(this);']),
    '    }',
    '}',
  ]
}

function testDatabaseFiles(context: Context): GeneratedFile[] {
  const pkg = context.base
  const imports = new JavaImports(pkg).add(
    'com.mongodb.ConnectionString',
    `${CORE}.MongoTemplate`,
    `${CORE}.index.MongoPersistentEntityIndexResolver`,
  )
  const database = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    '/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test. */',
    'final class TestDatabase {',
    '    static final String URL = System.getenv("TEST_DATABASE_URL");',
    '',
    '    private static MongoTemplate mongo;',
    '',
    '    private TestDatabase() {}',
    '',
    '    /** The template of the test database, with its collections and their indexes created again. */',
    '    static synchronized MongoTemplate open() {',
    '        if (URL == null)',
    '            throw new IllegalStateException("The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)");',
    '        if (mongo == null) mongo = Database.template(Database.client(URL), new ConnectionString(URL).getDatabase());',
    '        mongo.getDb().drop();',
    '        var resolver = new MongoPersistentEntityIndexResolver(mongo.getConverter().getMappingContext());',
    '        for (Class<?> entity : Database.ENTITIES) {',
    '            mongo.createCollection(entity);',
    '            resolver.resolveIndexFor(entity).forEach((index) -> mongo.indexOps(entity).createIndex(index));',
    '        }',
    '        return mongo;',
    '    }',
    '}',
    '',
  )
  const test = lines(
    `package ${pkg};`,
    '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    '',
    'import com.mongodb.ConnectionString;',
    'import org.junit.jupiter.api.Test;',
    '',
    '/** The tests run on the database they were asked to. */',
    'class DatabaseTest {',
    '    @Test',
    '    void isTheOneTestDatabaseUrlNames() {',
    '        assertEquals(new ConnectionString(TestDatabase.URL).getDatabase(), TestDatabase.open().getDb().getName());',
    '    }',
    '}',
    '',
  )
  return [
    { path: javaPath(pkg, 'TestDatabase', true), content: database },
    { path: javaPath(pkg, 'DatabaseTest', true), content: test },
  ]
}

function testSession(_context: Context, imports: JavaImports): Line[] {
  imports.add('org.junit.jupiter.api.BeforeEach')
  return [
    '    /** The repositories over the test database, opened empty for every test */',
    '    private SqlUnitOfWork uow;',
    '',
    '    @BeforeEach',
    '    void open() {',
    '        uow = new SqlUnitOfWork(TestDatabase.open());',
    '    }',
  ]
}

export const springDataOrm: JavaOrm = {
  id: 'springdata',
  holder: 'MongoTemplate',
  documents: true,
  ownModels: true,
  prefix: 'Mongo',
  url: 'mongodb://localhost:27017/app',
  forget: null,
  emptyList: () => 'new java.util.ArrayList<>()',
  databaseFiles: (context) => [databaseFile(context), documentsFile(context)],
  entityFile,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} documents in the database, through a MongoTemplate.${context.settings.transactions === 'repository' ? ' Every write is stored at once.' : ' It runs in the transaction already open, when there is one.'}`,
    head,
    body,
    tail,
  },
  unitOfWork,
  testDatabaseFiles,
  testSession,
  dependencies: () => [
    ...dependency('org.springframework.data', 'spring-data-mongodb', VERSIONS.springData),
    ...dependency('org.mongodb', 'mongodb-driver-sync', VERSIONS.driver),
  ],
  readme: {
    intro: 'entities, repositories and services with Spring Data MongoDB',
    layout: (context) => [
      `src/main/java/${context.base}/Database.java        the MongoTemplate of DATABASE_URL`,
      `src/main/java/${context.base}/Documents.java       entities as documents, and what changed in them`,
    ],
    note: '`Database.open()` makes one client for the application. In a Spring application, inject its own `MongoTemplate` into `MongoUnitOfWork` instead; transactions need a replica set.',
  },
}
