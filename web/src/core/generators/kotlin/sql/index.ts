/**
 * Kotlin without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through JDBC over one Connection
 * (sql/database.ts holds the connection and the helpers), plain classes as entities, a unit of work whose transaction is the
 * connection's, and tests on a real database created from the schema's DDL (SQLite in a temporary file, or the database
 * TEST_DATABASE_URL names: the DDL is written for one kind of database). Mirrors java/sql/index.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import { ktFile, type Context } from '../context.ts'
import { KtImports, ktString } from '../kotlin.ts'
import type { KotlinOrm } from '../orm.ts'
import { testPath } from '../tests.ts'
import { sqlDatabaseFiles, sqlEntityFiles } from './database.ts'
import { sqlBody, sqlHead, sqlHelpers } from './repository.ts'

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

const TRANSACTION = [
  '    override fun <T> transaction(work: (UnitOfWork) -> T): T {',
  '        // Joins the transaction already open',
  '        if (!connection.autoCommit) return work(this)',
  '        connection.autoCommit = false',
  '        try {',
  '            val result = work(this)',
  '            connection.commit()',
  '            return result',
  '        } catch (error: Throwable) {',
  '            connection.rollback()',
  '            throw error',
  '        } finally {',
  '            connection.autoCommit = true',
  '        }',
  '    }',
]

/** TestDatabase: the test database, with every table dropped and created again from the schema's DDL. */
function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const imports = new KtImports(context.base)
  if (sqlite) imports.add('java.io.File')
  const list = (name: string, doc: string, statements: string[]) => [
    `    /** ${doc} */`,
    `    private val ${name} = listOf(`,
    ...statements.map((statement) => `        ${ktString(statement)},`),
    '    )',
    '',
  ]
  const missing = ktString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)
  return ktFile(testPath(context, 'TestDatabase'), context.base, imports.write(), [
    sqlite
      ? '/** The test database: TEST_DATABASE_URL, or SQLite in a temporary file, created from the schema before every test. */'
      : `/** The test database: the ${NAMES[database]} database TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the schema before every test. */`,
    'object TestDatabase {',
    ...list('DROP', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database)),
    ...list('CREATE', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database)),
    '    /** The repositories over the test database, with every table dropped and created again. */',
    '    fun open(): SqlUnitOfWork {',
    '        val url = System.getenv("TEST_DATABASE_URL")',
    ...(sqlite
      ? ['            ?: "jdbc:sqlite:${File.createTempFile("test", ".db").also { it.deleteOnExit() }.absolutePath}"']
      : [
          '        // The tables are written for one kind of database: the tests cannot fall back to SQLite',
          `        checkNotNull(url) { ${missing} }`,
        ]),
    '        val user = System.getenv("TEST_DATABASE_USER") ?: ""',
    '        val connection = AppDatabase.connect(url, user, System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
    '        connection.createStatement().use { statement -> (DROP + CREATE).forEach { statement.execute(it) } }',
    '        return SqlUnitOfWork(connection)',
    '    }',
    '}',
  ])
}

function databaseTestFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  const imports = new KtImports(context.base).add('kotlin.test.Test', sqlite ? 'kotlin.test.assertTrue' : 'kotlin.test.assertEquals')
  return ktFile(testPath(context, 'DatabaseTest'), context.base, imports.write(), [
    '/** The tests run on the database they were asked to. */',
    'class DatabaseTest {',
    '    @Test',
    sqlite ? '    fun isSqlite() {' : '    fun isTheOneTestDatabaseUrlNames() {',
    '        TestDatabase.open().connection.use { connection ->',
    `            val value = Sql.one(connection, ${ktString(sql)}) { it.getString(1) }`,
    sqlite
      ? '            assertTrue(value!!.startsWith("3."))'
      : '            assertEquals(System.getenv("TEST_DATABASE_URL")!!.substringAfterLast("/").substringBefore("?"), value)',
    '        }',
    '    }',
    '}',
  ])
}

export const sqlOrm: KotlinOrm = {
  id: 'sql',
  holder: { name: 'connection', type: 'Connection', ktImport: 'java.sql.Connection', text: 'connection' },
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}"' : '"[]"'),
  databaseFiles: sqlDatabaseFiles,
  entityFiles: sqlEntityFiles,
  repository: {
    imports: () => [],
    doc: (context) =>
      context.settings.transactions === 'caller'
        ? 'with SQL through JDBC. Writes run in the transaction of whoever holds the connection, when there is one.'
        : 'with SQL through JDBC. A write joins the transaction already open, or is committed at once.',
    head: sqlHead,
    kept: (context) => (context.settings.repositoryInterfaces ? 'connection' : 'held'),
    body: sqlBody,
    helpers: sqlHelpers,
  },
  transaction: () => TRANSACTION,
  testDatabaseFiles: (context) => [testDatabaseFile(context), databaseTestFile(context)],
  openTest: (context) =>
    context.settings.transactions === 'caller'
      ? ['// The caller owns the transaction: the test opens it, and it ends with the test', 'uow.connection.autoCommit = false']
      : [],
  closeTest: ['if (!uow.connection.autoCommit) uow.connection.rollback()', 'uow.connection.close()'],
  // The JDBC driver of the database is all it needs
  dependencies: (_context, driver) => [`    runtimeOnly("${driver}")`],
  readme: {
    intro: 'plain entities, repositories with their own SQL over a JDBC `Connection` and services',
    layout: [
      'src/main/kotlin/app/AppDatabase.kt      the JDBC connection to DATABASE_URL',
      'src/main/kotlin/app/Sql.kt              how the repositories run SQL: values and refusals',
    ],
    entities: 'one entity per table',
    table: 'entity, repositories and service of each table',
  },
}
