/**
 * Java 21 without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through JDBC over one
 * Connection (sql/database.ts holds the connection and the helpers), plain classes as entities, a unit of work whose
 * transaction is the connection's, and tests on a real database created from the schema's DDL (SQLite in a file of
 * target/, or the database TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors
 * typescript/sql/index.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import { lines, type Line } from '../../types.ts'
import { javaPath, javaString, type JavaImports } from '../java.ts'
import { repositoryType, sqlRepositoryClass, type Context } from '../context.ts'
import type { JavaOrm } from '../orm.ts'
import { sqlDatabaseFiles, sqlEntityFile } from './database.ts'
import { sqlBody, sqlHead, sqlTail } from './repository.ts'

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

/** The class SqlUnitOfWork: the repositories over one connection, and its transaction. */
function unitOfWork(context: Context, imports: JavaImports, accessors: string[]): string[] {
  const operation = context.settings.transactions === 'operation'
  imports.add('java.sql.Connection')
  if (operation) imports.add('java.sql.SQLException')
  return [
    '/** The repositories over one JDBC connection, and its transaction. */',
    'public class SqlUnitOfWork implements UnitOfWork {',
    '    private final Connection connection;',
    ...context.tables.map((info) => `    private final ${repositoryType(context, info)} ${info.attr};`),
    '',
    '    public SqlUnitOfWork(Connection connection) {',
    '        this.connection = connection;',
    ...context.tables.map((info) => `        this.${info.attr} = new ${sqlRepositoryClass(info)}(connection);`),
    '    }',
    '',
    '    public Connection connection() {',
    '        return connection;',
    '    }',
    ...accessors,
    '',
    '    @Override',
    '    public <T> T transaction(Function<UnitOfWork, T> work) {',
    ...(operation
      ? [
          '        try {',
          '            // Joins the transaction already open',
          '            if (!connection.getAutoCommit()) return work.apply(this);',
          '            connection.setAutoCommit(false);',
          '            try {',
          '                T result = work.apply(this);',
          '                connection.commit();',
          '                return result;',
          '            } catch (RuntimeException error) {',
          '                connection.rollback();',
          '                throw error;',
          '            } finally {',
          '                connection.setAutoCommit(true);',
          '            }',
          '        } catch (SQLException error) {',
          '            throw Sql.failure(error);',
          '        }',
        ]
      : ['        return work.apply(this);']),
    '    }',
    '}',
  ]
}

/** TestDatabase: a connection to the test database, with every table dropped and created again from the schema's DDL. */
function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const list = (name: string, doc: string, statements: string[]) => [
    `    /** ${doc} */`,
    `    static final List<String> ${name} = List.of(`,
    ...statements.map((statement, index) => `            ${javaString(statement)}${index < statements.length - 1 ? ',' : ''}`),
    '    );',
  ]
  const content = lines(
    `package ${context.base};`,
    '',
    'import java.sql.Connection;',
    'import java.sql.SQLException;',
    'import java.sql.Statement;',
    'import java.util.List;',
    '',
    sqlite
      ? '/** The test database: TEST_DATABASE_URL, or SQLite in a file of target/, created from the schema before every test. */'
      : '/** The test database: the one TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the schema before every test. */',
    'final class TestDatabase {',
    sqlite
      ? '    static final String URL = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:sqlite:target/test.db?foreign_keys=true");'
      : [
          '    // The tables are written for one kind of database: the tests cannot fall back to SQLite',
          '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        ],
    '    static final String USER = System.getenv("TEST_DATABASE_USER");',
    '    static final String PASSWORD = System.getenv("TEST_DATABASE_PASSWORD");',
    '',
    ...list('DROP', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database)),
    '',
    ...list('CREATE', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database)),
    '',
    '    private TestDatabase() {}',
    '',
    '    /** A connection to the test database, with every table dropped and created again; on that one connection, as MySQL turns its foreign key checks off for the connection that asks. */',
    '    static Connection open() throws SQLException {',
    !sqlite && [
      '        if (URL == null)',
      `            throw new IllegalStateException("The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)");`,
    ],
    '        Connection connection = Database.connect(URL, USER, PASSWORD);',
    '        try (Statement statement = connection.createStatement()) {',
    '            for (String sql : DROP) statement.execute(sql);',
    '            for (String sql : CREATE) statement.execute(sql);',
    '        }',
    '        return connection;',
    '    }',
    '}',
    '',
  )
  return { path: javaPath(context.base, 'TestDatabase', true), content }
}

function databaseTestFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const query = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  const content = lines(
    `package ${context.base};`,
    '',
    sqlite ? 'import static org.junit.jupiter.api.Assertions.assertTrue;' : 'import static org.junit.jupiter.api.Assertions.assertEquals;',
    '',
    !sqlite && 'import java.net.URI;',
    'import java.sql.Connection;',
    'import java.sql.ResultSet;',
    'import java.sql.SQLException;',
    'import java.sql.Statement;',
    'import org.junit.jupiter.api.Test;',
    '',
    '/** The tests run on the database they were asked to. */',
    'class DatabaseTest {',
    '    @Test',
    sqlite ? '    void isSqlite() throws SQLException {' : '    void isTheOneTestDatabaseUrlNames() throws SQLException {',
    `        try (Connection connection = TestDatabase.open(); Statement statement = connection.createStatement(); ResultSet result = statement.executeQuery(${javaString(query)})) {`,
    '            result.next();',
    sqlite
      ? '            assertTrue(result.getString(1).startsWith("3."));'
      : '            assertEquals(URI.create(TestDatabase.URL.substring("jdbc:".length())).getPath().substring(1), result.getString(1));',
    '        }',
    '    }',
    '}',
    '',
  )
  return { path: javaPath(context.base, 'DatabaseTest', true), content }
}

/** A connection to the test database for every test, and the unit of work over it. */
function testSession(context: Context, imports: JavaImports): Line[] {
  imports.add('java.sql.Connection', 'java.sql.SQLException', 'org.junit.jupiter.api.AfterEach', 'org.junit.jupiter.api.BeforeEach')
  const caller = context.settings.transactions === 'caller'
  return [
    '    private Connection connection;',
    '    /** The repositories over the test database, opened empty for every test */',
    '    private SqlUnitOfWork uow;',
    '',
    '    @BeforeEach',
    '    void open() throws SQLException {',
    '        connection = TestDatabase.open();',
    caller && '        // The caller owns the transaction: the test opens it, and rolls it back at the end',
    caller && '        connection.setAutoCommit(false);',
    '        uow = new SqlUnitOfWork(connection);',
    '    }',
    '',
    '    @AfterEach',
    '    void close() throws SQLException {',
    '        if (!connection.getAutoCommit()) connection.rollback();',
    '        connection.close();',
    '    }',
  ]
}

export const sqlOrm: JavaOrm = {
  id: 'sql',
  holder: 'Connection',
  // Nothing is kept between reads
  forget: null,
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}"' : '"[]"'),
  databaseFiles: sqlDatabaseFiles,
  entityFile: sqlEntityFile,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, with SQL through JDBC. ${
        context.settings.transactions === 'repository'
          ? 'Every write is committed at once.'
          : 'It never commits: the transaction belongs to whoever holds the connection.'
      }`,
    head: sqlHead,
    body: sqlBody,
    tail: sqlTail,
  },
  unitOfWork,
  testDatabaseFiles: (context) => [testDatabaseFile(context), databaseTestFile(context)],
  testSession,
  // The JDBC driver of the database is all it needs
  dependencies: () => [],
  readme: {
    intro: 'plain entities, repositories with their own SQL over a JDBC `Connection`, and services',
    layout: (context) => [
      `src/main/java/${context.base}/Database.java        the JDBC connection to DATABASE_URL`,
      `src/main/java/${context.base}/Sql.java             how the repositories run SQL: values, rows and refusals`,
    ],
    note: '`Database.open()` opens one connection, which is fine for trying the code; in production give the unit of work connections from a pool such as HikariCP.',
  },
}
