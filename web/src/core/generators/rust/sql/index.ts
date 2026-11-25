/**
 * Rust without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through sqlx (sql/database.ts holds
 * the pool and the helpers), plain structs as entities, a unit of work over sqlx's transactions, and tests on a real database
 * created from the schema's DDL (SQLite in a temporary file, or the database TEST_DATABASE_URL names: the DDL is written for
 * one kind of database). Mirrors csharp/sql/index.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements } from '../../../schema/ddl.ts'
import type { Context, Crate } from '../context.ts'
import type { RustOrm } from '../orm.ts'
import { RsUses, rsString } from '../rust.ts'
import { external, TESTS, unitOfWork } from '../tests.ts'
import { databaseFile, driverTypes, entityFile } from './database.ts'
import { sqlBody, sqlHelpers } from './repository.ts'

const SQLX = '0.9.1'
const TOKIO = '1.54.1'
const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const uses = new RsUses().add(
    'sqlx::Row',
    'tokio::sync::Mutex',
    'tokio::sync::MutexGuard',
    `${unitOfWork(context)}::SqlUnitOfWork`,
    external(context, 'crate::database::Pool'),
  )
  if (sqlite) uses.add('std::sync::atomic::AtomicUsize', 'std::sync::atomic::Ordering')
  const list = (name: string, doc: string, statements: string[]) => [
    `/// ${doc}`,
    `const ${name}: &[&str] = &[`,
    ...statements.map((statement) => `    ${rsString(statement)},`),
    '];',
    '',
  ]
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  const get = database === 'postgresql' || sqlite ? 'try_get' : 'try_get_unchecked'
  return {
    path: `${TESTS}/database.rs`,
    content: [
      sqlite
        ? '//! The test database: TEST_DATABASE_URL, or SQLite in a new temporary file, created from the schema before every test.'
        : `//! The test database: the ${NAMES[database]} database TEST_DATABASE_URL names, created from the schema before every test.`,
      '',
      uses.write(),
      '',
      ...list('DROP', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database)),
      ...list('CREATE', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database)),
      '/// Every test empties the same database: they take turns',
      'static TURN: Mutex<()> = Mutex::const_new(());',
      '',
      '/// A pool of connections to the test database.',
      'async fn connect() -> Pool {',
      ...(sqlite
        ? [
            '    let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {',
            '        // A new file for every test: SQLite in memory would be another database on every connection',
            '        static FILES: AtomicUsize = AtomicUsize::new(0);',
            `        let name = format!(${rsString(`${context.crate}-{}-{}.db`)}, std::process::id(), FILES.fetch_add(1, Ordering::SeqCst));`,
            '        format!("sqlite://{}?mode=rwc", std::env::temp_dir().join(name).display())',
            '    });',
          ]
        : [
            '    // The tables are written for one kind of database: the tests cannot fall back to SQLite',
            `    let url = std::env::var("TEST_DATABASE_URL").expect(${rsString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)});`,
          ]),
      '    Pool::connect(&url).await.expect("the test database")',
      '}',
      '',
      '/// The repositories over the test database, with every table dropped and created again, and the turn of the test',
      '/// that holds it.',
      "pub async fn open() -> (MutexGuard<'static, ()>, SqlUnitOfWork) {",
      '    let turn = TURN.lock().await;',
      '    let pool = connect().await;',
      '    // On one connection, as MySQL turns its foreign key checks off for the connection that asks',
      '    let mut connection = pool.acquire().await.expect("a connection");',
      '    for sql in DROP.iter().chain(CREATE) {',
      '        sqlx::raw_sql(*sql).execute(&mut *connection).await.expect(sql);',
      '    }',
      '    drop(connection);',
      '    (turn, SqlUnitOfWork::new(pool))',
      '}',
      '',
      '#[tokio::test]',
      sqlite ? 'async fn is_sqlite() {' : 'async fn is_the_one_test_database_url_names() {',
      '    let _turn = TURN.lock().await;',
      `    let row = sqlx::query(${rsString(sql)}).fetch_one(&connect().await).await.expect("a row");`,
      `    let value: String = row.${get}(0).expect("a value");`,
      ...(sqlite
        ? ['    assert!(value.starts_with("3."));']
        : [
            '    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");',
            "    assert_eq!(url.rsplit('/').next().and_then(|name| name.split('?').next()), Some(value.as_str()));",
          ]),
      '}',
      '',
    ].join('\n'),
  }
}

function dependencies(context: Context, used: Set<Crate>): string[] {
  const features = [
    'runtime-tokio',
    'tls-rustls',
    driverTypes(context).feature,
    ...(used.has('chrono') ? ['chrono'] : []),
    ...(used.has('rust_decimal') && context.settings.database !== 'sqlite' ? ['rust_decimal'] : []),
    ...(used.has('uuid') ? ['uuid'] : []),
  ]
  return [
    `sqlx = { version = "${SQLX}", default-features = false, features = [${features.map((item) => `"${item}"`).join(', ')}] }`,
    `tokio = { version = "${TOKIO}", features = ["sync"] }`,
  ]
}

const UNIT = {
  uses: ['sqlx::Transaction', 'std::sync::Arc', 'tokio::sync::Mutex', 'crate::database::Driver', 'crate::database::Pool'],
  constructors: [
    '    /// The repositories over a pool: every write outside a transaction is committed at once.',
    '    pub fn new(pool: Pool) -> Self {',
    '        Self { db: Db::Pool(pool) }',
    '    }',
    '',
    '    /// The repositories inside a transaction someone else opened; commit() commits it.',
    "    pub fn in_transaction(transaction: Transaction<'static, Driver>) -> Self {",
    '        Self { db: Db::Transaction(Arc::new(Mutex::new(transaction))) }',
    '    }',
  ],
  begin: [
    '        match &self.db {',
    '            Db::Pool(pool) => Ok(Box::new(SqlUnitOfWork::in_transaction(pool.begin().await?))),',
    '            // Joins the transaction already open: whoever opened it commits it',
    '            Db::Transaction(transaction) | Db::Joined(transaction) => {',
    '                Ok(Box::new(SqlUnitOfWork { db: Db::Joined(transaction.clone()) }))',
    '            }',
    '        }',
  ],
  commit: [
    '        if let Db::Transaction(transaction) = self.db {',
    '            let transaction = Arc::into_inner(transaction)',
    '                .ok_or_else(|| sqlx::Error::Protocol("a unit of work that joined the transaction is still in use".to_string()))?;',
    '            transaction.into_inner().commit().await?;',
    '        }',
    '        Ok(())',
  ],
}

export const sqlOrm: RustOrm = {
  id: 'sql',
  label: 'sqlx',
  error: 'sqlx::Error',
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}".to_string()' : '"[]".to_string()'),
  databaseFiles: (context) => [databaseFile(context)],
  entityFiles: (context, info) => [entityFile(context, info)],
  repository: {
    uses: () => [],
    body: sqlBody,
    helpers: sqlHelpers,
  },
  unitOfWork: () => UNIT,
  testDatabaseFile,
  dependencies,
  readme: {
    intro: `plain entities, repositories with their own SQL through sqlx ${SQLX} and services`,
    entities: 'one entity per table',
    table: 'entity, repositories and service of each table',
    folder: 'The entities of every table.',
  },
}
