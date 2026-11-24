/**
 * Rust + SeaORM 2 (Strategy of orm.ts): entities and SeaORM descriptions of the tables, repositories that query them, a unit
 * of work over SeaORM's transactions, and tests on a database created from the descriptions.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { moduleOf, rsFile, type Context, type Crate, type TableInfo } from '../context.ts'
import type { RustOrm } from '../orm.ts'
import { RsUses, rsString } from '../rust.ts'
import { defaultUrl } from '../support.ts'
import { external, TESTS, unitOfWork } from '../tests.ts'
import { entityFile, nativeEnum, tableFile } from './entities.ts'
import { seaBody, seaHelpers } from './repository.ts'

const SEA_ORM = '2.0.4'

const DRIVERS: Record<string, string> = {
  postgresql: 'sqlx-postgres',
  mysql: 'sqlx-mysql',
  mariadb: 'sqlx-mysql',
  sqlite: 'sqlx-sqlite',
}

/** `database.rs`: the connection DATABASE_URL names, and Db, what repositories run their queries on. */
function databaseFile(context: Context): GeneratedFile {
  return rsFile(
    'src/database.rs',
    'use sea_orm::{DatabaseConnection, DatabaseExecutor, DatabaseTransaction, DbErr};',
    [
      `pub const DEFAULT_URL: &str = ${rsString(defaultUrl(context))};`,
      '',
      '/// A connection to the database at DATABASE_URL (DEFAULT_URL when it is not set).',
      'pub async fn connect() -> Result<DatabaseConnection, DbErr> {',
      '    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());',
      '    sea_orm::Database::connect(url).await',
      '}',
      '',
      '/// What repositories run their queries on: the connection, or a transaction opened on it.',
      'pub enum Db {',
      '    Connection(DatabaseConnection),',
      '    Transaction(DatabaseTransaction),',
      '}',
      '',
      'impl Db {',
      "    pub fn executor(&self) -> DatabaseExecutor<'_> {",
      '        match self {',
      '            Db::Connection(connection) => connection.into(),',
      '            Db::Transaction(transaction) => transaction.into(),',
      '        }',
      '    }',
      '}',
    ],
    ['The database DATABASE_URL names, through SeaORM. It never migrates: the database already exists.'],
  )
}

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

/** The tables in the order they can be created: the rows they point to first. */
function creationOrder(tables: TableInfo[]): TableInfo[] {
  const order: TableInfo[] = []
  const visit = (info: TableInfo, path: Set<string>) => {
    if (order.includes(info) || path.has(info.name)) return
    path.add(info.name)
    for (const key of info.table.foreignKeys) {
      const parent = tables.find((item) => item.name === key.references.table)
      if (parent && parent !== info) visit(parent, path)
    }
    order.push(info)
  }
  for (const info of tables) visit(info, new Set())
  return order
}

function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const postgres = database === 'postgresql'
  const tables = context.tables.filter((info) => info.writesEntity)
  const uses = new RsUses().add(
    'sea_orm::ConnectionTrait',
    'sea_orm::Database',
    'sea_orm::DatabaseConnection',
    'sea_orm::Schema',
    'sea_orm::Statement',
    'tokio::sync::Mutex',
    'tokio::sync::MutexGuard',
    `${unitOfWork(context)}::SqlUnitOfWork`,
  )
  if (sqlite) uses.add('std::sync::atomic::AtomicUsize', 'std::sync::atomic::Ordering')
  // Each table's module by a name of its own: by table, every one of them is `table`
  const tableModule = (info: TableInfo) => `${info.attr.replace(/^r#/, '')}_table`
  for (const info of tables) uses.add(`${external(context, moduleOf(context, info, 'table'))} as ${tableModule(info)}`)
  const quote = (name: string) => (database === 'mysql' || database === 'mariadb' ? `\`${name}\`` : `"${name}"`)
  const qualifiedName = (info: TableInfo) =>
    info.table.schema && postgres ? `${quote(info.table.schema)}.${quote(info.name)}` : quote(info.name)
  const schemas = postgres ? [...new Set(context.tables.map((info) => info.table.schema).filter((name): name is string => !!name))] : []
  const enums = postgres
    ? context.schema.enums.filter((item) =>
        context.tables.some((info) => info.columns.some((column) => nativeEnum(context, column.column) === item)),
      )
    : []
  const sqlQuote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const run = (sql: string) => `    db.execute_unprepared(${rsString(sql)}).await.expect(${rsString(sql)});`
  const order = creationOrder(tables)
  const sql = postgres ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  return {
    path: `${TESTS}/database.rs`,
    content: [
      sqlite
        ? '//! The test database: TEST_DATABASE_URL, or SQLite in a new temporary file, created from the SeaORM entities before every test.'
        : `//! The test database: the ${NAMES[database]} database TEST_DATABASE_URL names, created from the SeaORM entities before every test.`,
      '',
      uses.write(),
      '',
      '/// Every test empties the same database: they take turns',
      'static TURN: Mutex<()> = Mutex::const_new(());',
      '',
      '/// A connection to the test database.',
      'async fn connect() -> DatabaseConnection {',
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
            '    // The entities are written for one kind of database: the tests cannot fall back to SQLite',
            `    let url = std::env::var("TEST_DATABASE_URL").expect(${rsString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)});`,
          ]),
      '    Database::connect(&url).await.expect("the test database")',
      '}',
      '',
      '/// The repositories over the test database, with every table dropped and created again, and the turn of the test',
      '/// that holds it.',
      "pub async fn open() -> (MutexGuard<'static, ()>, SqlUnitOfWork) {",
      '    let turn = TURN.lock().await;',
      '    let db = connect().await;',
      ...schemas.map((name) => run(`DROP SCHEMA IF EXISTS ${quote(name)} CASCADE`)),
      // The rows that point to others first
      ...[...order].reverse().map((info) => run(`DROP TABLE IF EXISTS ${qualifiedName(info)}${postgres ? ' CASCADE' : ''}`)),
      ...enums.flatMap((item) => [
        run(`DROP TYPE IF EXISTS ${quote(item.name)} CASCADE`),
        run(`CREATE TYPE ${quote(item.name)} AS ENUM (${item.values.map(sqlQuote).join(', ')})`),
      ]),
      ...schemas.map((name) => run(`CREATE SCHEMA ${quote(name)}`)),
      '    Schema::new(db.get_database_backend())',
      '        .builder()',
      ...tables.map((info) => `        .register(${tableModule(info)}::Entity)`),
      '        .apply(&db)',
      '        .await',
      '        .expect("the tables");',
      '    (turn, SqlUnitOfWork::new(db))',
      '}',
      '',
      '#[tokio::test]',
      sqlite ? 'async fn is_sqlite() {' : 'async fn is_the_one_test_database_url_names() {',
      '    let _turn = TURN.lock().await;',
      '    let db = connect().await;',
      `    let row = db.query_one_raw(Statement::from_string(db.get_database_backend(), ${rsString(sql)})).await.expect("a query").expect("a row");`,
      '    let value: String = row.try_get_by_index(0).expect("a value");',
      sqlite
        ? '    assert!(value.starts_with("3."));'
        : '    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");\n    assert_eq!(url.rsplit(\'/\').next().and_then(|name| name.split(\'?\').next()), Some(value.as_str()));',
      '}',
      '',
    ].join('\n'),
  }
}

function dependencies(context: Context, used: Set<Crate>): string[] {
  const features = [
    'macros',
    'runtime-tokio-rustls',
    DRIVERS[context.settings.database] ?? DRIVERS.postgresql,
    ...(used.has('chrono') ? ['with-chrono'] : []),
    ...(used.has('rust_decimal') ? ['with-rust_decimal'] : []),
    ...(used.has('uuid') ? ['with-uuid'] : []),
  ]
  return [`sea-orm = { version = "${SEA_ORM}", default-features = false, features = [${features.map((item) => `"${item}"`).join(', ')}] }`]
}

const UNIT = {
  uses: ['sea_orm::DatabaseConnection', 'sea_orm::DatabaseTransaction', 'sea_orm::TransactionTrait'],
  constructors: [
    '    /// The repositories over a connection: every write outside a transaction is committed at once.',
    '    pub fn new(connection: DatabaseConnection) -> Self {',
    '        Self { db: Db::Connection(connection) }',
    '    }',
    '',
    '    /// The repositories inside a transaction someone else opened; commit() commits it.',
    '    pub fn in_transaction(transaction: DatabaseTransaction) -> Self {',
    '        Self { db: Db::Transaction(transaction) }',
    '    }',
  ],
  begin: [
    '        // Inside a transaction, a new one is a savepoint of it',
    '        let transaction = match &self.db {',
    '            Db::Connection(connection) => connection.begin().await?,',
    '            Db::Transaction(transaction) => transaction.begin().await?,',
    '        };',
    '        Ok(Box::new(SqlUnitOfWork::in_transaction(transaction)))',
  ],
  commit: [
    '        if let Db::Transaction(transaction) = self.db {',
    '            transaction.commit().await?;',
    '        }',
    '        Ok(())',
  ],
}

export const seaormOrm: RustOrm = {
  id: 'seaorm',
  label: 'SeaORM',
  error: 'sea_orm::DbErr',
  emptyList: (context) => (context.settings.database === 'postgresql' ? '"{}".to_string()' : '"[]".to_string()'),
  databaseFile,
  entityFiles: (context, info) => [entityFile(context, info), tableFile(context, info)],
  repository: {
    uses: (context, info) => [`${moduleOf(context, info, 'table')} as table`],
    body: seaBody,
    helpers: seaHelpers,
  },
  unitOfWork: () => UNIT,
  testDatabaseFile,
  dependencies,
  readme: {
    intro: `entities and SeaORM ${SEA_ORM} descriptions of the tables, repositories and services`,
    entities: 'one entity and one SeaORM description per table',
    table: 'entity, SeaORM description, repositories and service of each table',
    folder: 'The entities of every table, and the SeaORM description of each table.',
  },
}
