/**
 * Java 21 + JPA (Hibernate 7) (Strategy of orm.ts): entities that reflect the database, repositories over an
 * EntityManager, a unit of work whose transaction is the EntityManager's, and tests on a database Hibernate creates
 * from the entities.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { javaPath, javaString, JavaImports } from '../java.ts'
import { packageOf, repositoryType, sqlRepositoryClass, type Context } from '../context.ts'
import type { JavaOrm } from '../orm.ts'
import { file } from '../support.ts'
import { dependency, VERSIONS } from '../project.ts'
import { entityFile, enumTypes } from './entities.ts'
import { jpaBody, jpaHead, jpaTail } from './repository.ts'

/** `Database`: the EntityManagerFactory of the database DATABASE_URL names, with every entity. */
export function databaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  const imports = new JavaImports(pkg).add(
    'jakarta.persistence.EntityManagerFactory',
    'org.hibernate.jpa.HibernatePersistenceConfiguration',
  )
  for (const info of context.tables) imports.add(`${packageOf(context, info, 'entity')}.${info.entity}`)
  const url = {
    postgresql: 'jdbc:postgresql://localhost:5432/app',
    mysql: 'jdbc:mysql://localhost:3306/app',
    mariadb: 'jdbc:mariadb://localhost:3306/app',
    sqlite: 'jdbc:sqlite:app.db?foreign_keys=true',
  }[context.settings.database as 'postgresql' | 'mysql' | 'mariadb' | 'sqlite']
  return file(
    pkg,
    'Database',
    [
      '/** The database DATABASE_URL names (a JDBC URL; DATABASE_USER and DATABASE_PASSWORD), through Hibernate. */',
      'public final class Database {',
      `    public static final String DEFAULT_URL = "${url}";`,
      '',
      '    private Database() {}',
      '',
      '    /** Every entity, so Hibernate knows every table */',
      `    public static final List<Class<?>> ENTITIES = List.of(${context.tables.map((info) => `${info.entity}.class`).join(', ')});`,
      '',
      '    /** The configuration of the database at url: give it a connection pool or a DataSource for production. */',
      '    public static HibernatePersistenceConfiguration configuration(String url, String user, String password) {',
      '        HibernatePersistenceConfiguration configuration = new HibernatePersistenceConfiguration("app")',
      '                .managedClasses(ENTITIES)',
      '                .jdbcUrl(url)',
      '                // The services check the values; the database fills its defaults',
      '                .property("hibernate.check_nullability", false)',
      '                // Every name is quoted, so names like rank or order work and are used exactly as the database has them',
      '                .property("hibernate.globally_quoted_identifiers", true)',
      '                .property("hibernate.globally_quoted_identifiers_skip_column_definitions", true);',
      '        if (user != null) configuration.jdbcCredentials(user, password == null ? "" : password);',
      '        return configuration;',
      '    }',
      '',
      '    /** The EntityManagerFactory of DATABASE_URL, DATABASE_USER and DATABASE_PASSWORD. */',
      '    public static EntityManagerFactory open() {',
      '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
      '        return configuration(url, System.getenv("DATABASE_USER"), System.getenv("DATABASE_PASSWORD")).createEntityManagerFactory();',
      '    }',
      '}',
    ],
    imports.add('java.util.List'),
  )
}

/** The class SqlUnitOfWork: the repositories over one EntityManager, and its transaction. */
function unitOfWork(context: Context, imports: JavaImports, accessors: string[]): string[] {
  const settings = context.settings
  imports.add('jakarta.persistence.EntityManager')
  if (settings.transactions === 'operation') imports.add('jakarta.persistence.EntityTransaction')
  return [
    '/** The repositories over one EntityManager, and its transaction. */',
    'public class SqlUnitOfWork implements UnitOfWork {',
    '    private final EntityManager entityManager;',
    ...context.tables.map((info) => `    private final ${repositoryType(context, info)} ${info.attr};`),
    '',
    '    public SqlUnitOfWork(EntityManager entityManager) {',
    '        this.entityManager = entityManager;',
    ...context.tables.map((info) => `        this.${info.attr} = new ${sqlRepositoryClass(info)}(entityManager);`),
    '    }',
    '',
    '    public EntityManager entityManager() {',
    '        return entityManager;',
    '    }',
    ...accessors,
    '',
    '    @Override',
    '    public <T> T transaction(Function<UnitOfWork, T> work) {',
    ...(settings.transactions === 'operation'
      ? [
          '        EntityTransaction transaction = entityManager.getTransaction();',
          '        // Joins the transaction already open',
          '        if (transaction.isActive()) return work.apply(this);',
          '        transaction.begin();',
          '        try {',
          '            T result = work.apply(this);',
          '            transaction.commit();',
          '            return result;',
          '        } catch (RuntimeException error) {',
          '            if (transaction.isActive()) transaction.rollback();',
          '            throw error;',
          '        }',
        ]
      : ['        return work.apply(this);']),
    '    }',
    '}',
  ]
}

function testDatabaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const types = enumTypes(context)
  const imports = new JavaImports(pkg).add('jakarta.persistence.EntityManager', 'jakarta.persistence.EntityManagerFactory')
  if (types.length > 0) imports.add('java.sql.Connection', 'java.sql.DriverManager', 'java.sql.SQLException', 'java.sql.Statement')
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    sqlite
      ? '/** The test database: TEST_DATABASE_URL, or SQLite in a file of target/, created from the entities before every test. */'
      : '/** The test database: the one TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the entities before every test. */',
    'final class TestDatabase {',
    sqlite
      ? '    static final String URL = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:sqlite:target/test.db?foreign_keys=true");'
      : [
          '    // The entities are written for one kind of database: the tests cannot fall back to SQLite',
          '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        ],
    '    static final String USER = System.getenv("TEST_DATABASE_USER");',
    '    static final String PASSWORD = System.getenv("TEST_DATABASE_PASSWORD");',
    '',
    '    private static EntityManagerFactory factory;',
    '',
    '    private TestDatabase() {}',
    '',
    '    /** An EntityManager over the test database, with every table dropped and created again from the entities. */',
    '    static synchronized EntityManager open() {',
    !sqlite && [
      '        if (URL == null)',
      `            throw new IllegalStateException("The database tests need a disposable ${{ postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }[database as 'postgresql']} database: set TEST_DATABASE_URL (it is emptied)");`,
    ],
    '        if (factory == null) {',
    types.length > 0 && '            createTypes();',
    '            factory = Database.configuration(URL, USER, PASSWORD).createEntityManagerFactory();',
    '        }',
    '        factory.getSchemaManager().drop(true);',
    '        factory.getSchemaManager().create(true);',
    '        return factory.createEntityManager();',
    '    }',
    types.length > 0 && [
      '',
      '    /** The enum types of the database the entities use, which Hibernate does not create. */',
      '    private static void createTypes() {',
      '        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD); Statement statement = connection.createStatement()) {',
      ...types.map(
        (sql) => `            statement.execute(${javaString(`DO $$ BEGIN ${sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)});`,
      ),
      '        } catch (SQLException error) {',
      '            throw new IllegalStateException(error);',
      '        }',
      '    }',
    ],
    '}',
    '',
  )
  return { path: javaPath(pkg, 'TestDatabase', true), content }
}

function databaseTestFile(context: Context): GeneratedFile {
  const pkg = context.base
  const database = context.settings.database
  const query =
    database === 'postgresql' ? 'SELECT current_database()' : database === 'sqlite' ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  const content = lines(
    `package ${pkg};`,
    '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    database === 'sqlite' && 'import static org.junit.jupiter.api.Assertions.assertTrue;',
    '',
    'import jakarta.persistence.EntityManager;',
    database !== 'sqlite' && 'import java.net.URI;',
    'import org.junit.jupiter.api.Test;',
    '',
    '/** The tests run on the database they were asked to. */',
    'class DatabaseTest {',
    '    @Test',
    database === 'sqlite' ? '    void isSqlite() {' : '    void isTheOneTestDatabaseUrlNames() {',
    '        EntityManager entityManager = TestDatabase.open();',
    `        Object result = entityManager.createNativeQuery(${javaString(query)}).getSingleResult();`,
    '        entityManager.close();',
    database === 'sqlite'
      ? '        assertTrue(String.valueOf(result).startsWith("3."));'
      : '        assertEquals(URI.create(TestDatabase.URL.substring("jdbc:".length())).getPath().substring(1), String.valueOf(result));',
    '    }',
    '}',
    '',
  )
  return { path: javaPath(pkg, 'DatabaseTest', true), content }
}

/** An EntityManager over the test database for every test, and the unit of work over it. */
function testSession(context: Context, imports: JavaImports): Line[] {
  imports.add('jakarta.persistence.EntityManager', 'org.junit.jupiter.api.AfterEach', 'org.junit.jupiter.api.BeforeEach')
  const caller = context.settings.transactions === 'caller'
  return [
    '    private EntityManager entityManager;',
    '    /** The repositories over the test database, opened empty for every test */',
    '    private SqlUnitOfWork uow;',
    '',
    '    @BeforeEach',
    '    void open() {',
    '        entityManager = TestDatabase.open();',
    caller && '        // The caller owns the transaction: the test opens it, and rolls it back at the end',
    caller && '        entityManager.getTransaction().begin();',
    '        uow = new SqlUnitOfWork(entityManager);',
    '    }',
    '',
    '    @AfterEach',
    '    void close() {',
    '        if (entityManager.getTransaction().isActive()) entityManager.getTransaction().rollback();',
    '        entityManager.close();',
    '    }',
  ]
}

/** Hibernate (with the dialects of SQLite) and, for JSON columns, Jackson. */
function dependencies(context: Context): (Line | Line[])[] {
  const json = context.tables.some((info) =>
    info.columns.some((column) => column.column.type.kind === 'json' || column.column.type.kind === 'array'),
  )
  return [
    ...dependency('org.hibernate.orm', 'hibernate-core', VERSIONS.hibernate),
    context.settings.database === 'sqlite' && dependency('org.hibernate.orm', 'hibernate-community-dialects', VERSIONS.hibernate),
    // Hibernate reads and writes JSON columns with Jackson
    json && dependency('com.fasterxml.jackson.core', 'jackson-databind', VERSIONS.jackson),
  ]
}

export const jpaOrm: JavaOrm = {
  id: 'jpa',
  holder: 'EntityManager',
  forget: 'uow.entityManager().clear();',
  emptyList: () => '"[]"',
  databaseFiles: (context) => [databaseFile(context)],
  entityFile,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through an EntityManager. ${
        context.settings.transactions === 'caller'
          ? 'It never commits: writes run in the transaction of whoever holds the EntityManager.'
          : 'A write joins the transaction already open, or commits at once.'
      }`,
    head: jpaHead,
    body: jpaBody,
    tail: (context) => jpaTail(context),
  },
  unitOfWork,
  testDatabaseFiles: (context) => [testDatabaseFile(context), databaseTestFile(context)],
  testSession,
  dependencies,
  readme: {
    intro: 'JPA entities, repositories over an `EntityManager` (Hibernate) and services',
    layout: (context) => [`src/main/java/${context.base}/Database.java        the EntityManagerFactory of DATABASE_URL, with every entity`],
    note: '`Database.open()` uses the connection pool built into Hibernate, which is fine for trying the code; in production give `Database.configuration(...)` a `DataSource` or a pool such as HikariCP.',
  },
}
