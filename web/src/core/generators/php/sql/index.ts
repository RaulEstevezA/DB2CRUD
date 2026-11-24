/**
 * PHP without an ORM (Strategy of common/orm.ts): repositories that write their SQL and run it through PDO (sql/database.ts
 * holds the connection and the helpers), plain classes as entities, a unit of work whose transaction is the connection's, and
 * tests on a real database created from the schema's DDL (SQLite in memory, or the database TEST_DATABASE_URL names: the DDL
 * is written for one kind of database). Mirrors csharp/sql/index.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import type { Line } from '../../types.ts'
import { className, namespaceOf, sqlRepositoryClass, type Context } from '../common/context.ts'
import type { PhpOrm } from '../common/orm.ts'
import { fieldName, phpString, PhpUses } from '../common/php.ts'
import { repositoryAssignments, repositoryProperties } from '../common/support.ts'
import { testFile, TESTS_NS } from '../common/tests.ts'
import { defaultUrl, sqlDatabaseFiles, sqlEntityFile, sqlPhpType } from './database.ts'
import { sqlBody, sqlHelpers, sqlInit } from './repository.ts'

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }
const EXTENSIONS: Record<string, string> = { postgresql: 'pdo_pgsql', mysql: 'pdo_mysql', mariadb: 'pdo_mysql', sqlite: 'pdo_sqlite' }

function unitOfWork(context: Context, uses: PhpUses): Line[] {
  uses.add('PDO')
  const properties = repositoryProperties(context, uses, (info) => info.attr)
  for (const info of context.tables) uses.add(className(namespaceOf(context, info, 'repository'), sqlRepositoryClass(info)))
  const operation = context.settings.transactions === 'operation'
  return [
    '/** The repositories over one PDO connection, and its transaction. */',
    'final class SqlUnitOfWork implements UnitOfWork',
    '{',
    ...properties.map((line) => `    ${line}`),
    '',
    '    public function __construct(public readonly PDO $db)',
    '    {',
    ...repositoryAssignments(context, (info) => `new ${sqlRepositoryClass(info)}($db)`).map((line) => `        ${line}`),
    '    }',
    '',
    '    public function transaction(callable $work): mixed',
    '    {',
    ...(operation
      ? [
          '        // Joins the transaction already open',
          '        if ($this->db->inTransaction()) {',
          '            return $work($this);',
          '        }',
          '        $this->db->beginTransaction();',
          '        try {',
          '            $result = $work($this);',
          '            $this->db->commit();',
          '            return $result;',
          '        } catch (\\Throwable $error) {',
          '            if ($this->db->inTransaction()) {',
          '                $this->db->rollBack();',
          '            }',
          '            throw $error;',
          '        }',
        ]
      : ['        return $work($this);']),
    '    }',
    '}',
  ]
}

/** TestDatabase: the test database, with every table dropped and created again from the schema's DDL. */
function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const list = (name: string, doc: string, statements: string[]) => [
    `    /** ${doc} */`,
    `    private const ${name} = [`,
    ...statements.map((statement) => `        ${phpString(statement)},`),
    '    ];',
    '',
  ]
  const missing = phpString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)
  return testFile('TestDatabase', new PhpUses(TESTS_NS).add(`${context.base}\\Database`, `${context.base}\\SqlUnitOfWork`), [
    sqlite
      ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created from the schema before every test. */'
      : `/** The test database: the ${NAMES[database]} database TEST_DATABASE_URL names, created from the schema before every test. */`,
    'final class TestDatabase',
    '{',
    ...list('DROP', 'Removes every table, so the database starts empty', dropStatements(context.schema, database)),
    ...list('CREATE', 'Creates every table, in an order the database accepts', createStatements(context.schema, database)),
    '    public static function url(): ?string',
    '    {',
    "        $url = getenv('TEST_DATABASE_URL');",
    "        return is_string($url) && $url !== '' ? $url : null;",
    '    }',
    '',
    '    /** The repositories over the test database, with every table dropped and created again. */',
    '    public static function open(): SqlUnitOfWork',
    '    {',
    ...(sqlite
      ? ["        $db = Database::open(self::url() ?? 'sqlite:///:memory:');"]
      : [
          '        // The tables are written for one kind of database: the tests cannot fall back to SQLite',
          `        $db = Database::open(self::url() ?? throw new \\RuntimeException(${missing}));`,
        ]),
    '        foreach ([...self::DROP, ...self::CREATE] as $sql) {',
    '            $db->exec($sql);',
    '        }',
    '        return new SqlUnitOfWork($db);',
    '    }',
    '}',
  ])
}

function databaseTestFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  return testFile('DatabaseTest', new PhpUses(TESTS_NS).add(`${context.base}\\Sql`, 'PHPUnit\\Framework\\TestCase'), [
    '/** The tests run on the database they were asked to. */',
    'final class DatabaseTest extends TestCase',
    '{',
    sqlite ? '    public function testIsSqlite(): void' : '    public function testIsTheOneTestDatabaseUrlNames(): void',
    '    {',
    `        $name = Sql::one(TestDatabase::open()->db, ${phpString(sql)})[0];`,
    sqlite
      ? "        self::assertStringStartsWith('3.', $name);"
      : "        self::assertSame(ltrim((string) parse_url((string) TestDatabase::url(), PHP_URL_PATH), '/'), $name);",
    '    }',
    '}',
  ])
}

export const sqlOrm: PhpOrm = {
  id: 'sql',
  label: 'SQL (PDO)',
  intro: 'plain entities, repositories with their own SQL through PDO and services',
  property: (column) => fieldName(column.name),
  phpType: sqlPhpType,
  entityFile: sqlEntityFile,
  databaseFiles: sqlDatabaseFiles,
  repository: {
    doc: () => 'with SQL through PDO.',
    init: sqlInit,
    body: sqlBody,
    helpers: sqlHelpers,
  },
  unitOfWork,
  // Nothing is kept between reads
  forget: () => null,
  begin: (uow) => `${uow}->db->beginTransaction()`,
  // PDO closes the connection when nothing holds it, and undoes its transaction
  close: (uow) => `unset(${uow})`,
  testDatabase: (context) => [testDatabaseFile(context), databaseTestFile(context)],
  require: (context) => ({ [`ext-${EXTENSIONS[context.settings.database] ?? 'pdo_pgsql'}`]: '*' }),
  defaultUrl,
  layout: () => [
    'src/Database.php             the PDO connection to DATABASE_URL',
    'src/Sql.php                  how the repositories run SQL: values and refusals',
  ],
}
