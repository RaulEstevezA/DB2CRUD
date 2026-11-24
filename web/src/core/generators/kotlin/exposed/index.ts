/**
 * Kotlin + Exposed 1.6 (Strategy of orm.ts): entities and table objects as the database has them, repositories with
 * Exposed's DSL, a unit of work whose transaction is Exposed's, and tests on a database created from the table objects.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { ktFile, packageOf, pathOf, qualified, type Context } from '../context.ts'
import { KtImports, ktString } from '../kotlin.ts'
import type { KotlinOrm } from '../orm.ts'
import { defaultUrl } from '../support.ts'
import { testPath } from '../tests.ts'
import { entityFile, enumColumnFile, nativeEnum, tableObjectFile, usesEnumColumns } from './entities.ts'
import { exposedBody, exposedHelpers } from './repository.ts'

const EXPOSED = '1.6.1'

/** Exposed's transaction, by another name than the unit of work's own transaction(). */
const EXPOSED_TRANSACTION = 'org.jetbrains.exposed.v1.jdbc.transactions.transaction as exposedTransaction'

/** `AppDatabase`: the database DATABASE_URL names (with DATABASE_USER and DATABASE_PASSWORD). */
function databaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  return ktFile(pathOf(pkg, 'AppDatabase'), pkg, 'import org.jetbrains.exposed.v1.jdbc.Database', [
    '/** The database DATABASE_URL names (a JDBC URL), through Exposed. It never migrates: the database already exists. */',
    'object AppDatabase {',
    `    const val DEFAULT_URL = ${ktString(defaultUrl(context))}`,
    '',
    '    /** A connection to the database at url (DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD, by default). */',
    '    fun connect(',
    '        url: String = System.getenv("DATABASE_URL") ?: DEFAULT_URL,',
    '        user: String = System.getenv("DATABASE_USER") ?: "",',
    '        password: String = System.getenv("DATABASE_PASSWORD") ?: "",',
    '    ): Database = Database.connect(url, user = user, password = password)',
    '}',
  ])
}

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

function testDatabaseFiles(context: Context): GeneratedFile[] {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const imports = new KtImports(context.base).add(
    'org.jetbrains.exposed.v1.jdbc.Database',
    'org.jetbrains.exposed.v1.jdbc.SchemaUtils',
    EXPOSED_TRANSACTION,
  )
  const tables = context.tables.filter((info) => info.writesEntity)
  for (const info of tables) imports.add(qualified(packageOf(context, info, 'entity'), info.tableObject))
  const postgres = database === 'postgresql'
  const schemas = postgres ? [...new Set(context.tables.map((info) => info.table.schema).filter((name): name is string => !!name))] : []
  const enums = postgres
    ? context.schema.enums.filter((item) =>
        context.tables.some((info) => info.columns.some((column) => nativeEnum(context, column.column) === item)),
      )
    : []
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const statement = (sql: string) => `            exec(${ktString(sql)})`
  if (sqlite) imports.add('java.io.File')
  const files: GeneratedFile[] = [
    ktFile(testPath(context, 'TestDatabase'), context.base, imports.write(), [
      sqlite
        ? '/** The test database: TEST_DATABASE_URL, or SQLite in a temporary file, created from the table objects before every test. */'
        : `/** The test database: the ${NAMES[database]} database TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the table objects before every test. */`,
      'object TestDatabase {',
      `    private val TABLES = arrayOf(${tables.map((info) => info.tableObject).join(', ')})`,
      '',
      '    /** The repositories over the test database, with every table dropped and created again. */',
      '    fun open(): SqlUnitOfWork {',
      '        val url = System.getenv("TEST_DATABASE_URL")',
      ...(sqlite
        ? [
            '        val db =',
            '            if (url == null) Database.connect("jdbc:sqlite:${File.createTempFile("test", ".db").absolutePath}?foreign_keys=true")',
            '            else Database.connect(url, user = System.getenv("TEST_DATABASE_USER") ?: "", password = System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
          ]
        : [
            '        // The table objects are written for one kind of database: the tests cannot fall back to SQLite',
            `        checkNotNull(url) { ${ktString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)} }`,
            '        val db = Database.connect(url, user = System.getenv("TEST_DATABASE_USER") ?: "", password = System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
          ]),
      '        exposedTransaction(db) {',
      ...schemas.map((name) => statement(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)),
      '            SchemaUtils.drop(*TABLES)',
      ...enums.flatMap((item) => [
        statement(`DROP TYPE IF EXISTS "${item.name}" CASCADE`),
        statement(`CREATE TYPE "${item.name}" AS ENUM (${item.values.map(quote).join(', ')})`),
      ]),
      ...schemas.map((name) => statement(`CREATE SCHEMA "${name}"`)),
      '            SchemaUtils.create(*TABLES)',
      '        }',
      '        return SqlUnitOfWork(db)',
      '    }',
      '}',
    ]),
  ]
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  files.push(
    ktFile(
      testPath(context, 'DatabaseTest'),
      context.base,
      new KtImports(context.base)
        .add(EXPOSED_TRANSACTION, 'kotlin.test.Test', 'kotlin.test.assertEquals', 'kotlin.test.assertTrue')
        .write(),
      [
        '/** The tests run on the database they were asked to. */',
        'class DatabaseTest {',
        '    @Test',
        sqlite ? '    fun isSqlite() {' : '    fun isTheOneTestDatabaseUrlNames() {',
        '        val uow = TestDatabase.open()',
        `        val value = exposedTransaction(uow.db) { exec(${ktString(sql)}) { it.next(); it.getString(1) } }`,
        sqlite
          ? '        assertTrue(value!!.startsWith("3."))'
          : '        assertEquals(System.getenv("TEST_DATABASE_URL")!!.substringAfterLast("/").substringBefore("?"), value)',
        '    }',
        '}',
      ],
    ),
  )
  return files
}

function transaction(imports: KtImports): string[] {
  imports.add(EXPOSED_TRANSACTION)
  return ['    override fun <T> transaction(work: (UnitOfWork) -> T): T = exposedTransaction(db) { work(this@SqlUnitOfWork) }']
}

export const exposedOrm: KotlinOrm = {
  id: 'exposed',
  holder: { name: 'db', type: 'Database', ktImport: 'org.jetbrains.exposed.v1.jdbc.Database', text: 'database' },
  emptyList: () => '"[]"',
  databaseFiles: (context) => [databaseFile(context), enumColumnFile(context)],
  entityFiles: (context, info) => [entityFile(context, info), tableObjectFile(context, info)],
  repository: {
    imports: (context, info) => [qualified(packageOf(context, info, 'entity'), info.tableObject), EXPOSED_TRANSACTION],
    doc: (context) =>
      context.settings.transactions === 'caller'
        ? 'through Exposed. Every call joins the transaction of whoever holds the database, when there is one.'
        : 'through Exposed. Every call joins the transaction already open, or is committed at once.',
    head: () => [],
    kept: () => 'db',
    body: exposedBody,
    helpers: exposedHelpers,
  },
  transaction,
  testDatabaseFiles,
  openTest: () => [],
  closeTest: [],
  dependencies: (context, driver) => [
    `    implementation("org.jetbrains.exposed:exposed-core:${EXPOSED}")`,
    `    implementation("org.jetbrains.exposed:exposed-jdbc:${EXPOSED}")`,
    `    implementation("org.jetbrains.exposed:exposed-java-time:${EXPOSED}")`,
    // The column type of PostgreSQL's enums sends a PGobject: the driver is needed to compile, not only to run
    `    ${usesEnumColumns(context) ? 'implementation' : 'runtimeOnly'}("${driver}")`,
  ],
  readme: {
    intro: `entities and table objects for Exposed ${EXPOSED}, repositories and services`,
    layout: ['src/main/kotlin/app/AppDatabase.kt      the connection of DATABASE_URL'],
    entities: 'one entity and one table object per table',
    table: 'entity, table object, repositories and service of each table',
  },
}
