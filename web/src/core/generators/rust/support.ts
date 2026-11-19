/**
 * What every Rust project shares: the domain errors services return (no HTTP codes), the pages lists are read in,
 * Patch (a field of an update: absent, or a value that may be None), the connection DATABASE_URL names, and the unit of
 * work over the repositories, with its database and in-memory versions. A unit of work opens a transaction with
 * `begin()`; its changes are kept by `commit()`, and dropped when it is dropped without one.
 */
import type { GeneratedFile } from '../../export/files.ts'
import {
  fileOf,
  memoryRepository,
  moduleOf,
  pathIn,
  repositoryTrait,
  rsFile,
  sqlRepository,
  type Context,
  type TableInfo,
} from './context.ts'
import { RsUses, rsString } from './rust.ts'

export const ERRORS = 'crate::errors'
export const COMMON = 'crate::common'
export const DOMAIN_ERROR = `${ERRORS}::DomainError`
export const UNIT_OF_WORK = 'crate::unit_of_work::UnitOfWork'

export function errorsFile(): GeneratedFile {
  return rsFile(
    fileOf(ERRORS),
    '',
    [
      '/// What is wrong with one field.',
      '#[derive(Debug, Clone, PartialEq)]',
      'pub struct FieldError {',
      '    pub field: String,',
      '    pub message: String,',
      '}',
      '',
      'impl FieldError {',
      '    pub fn new(field: &str, message: &str) -> Self {',
      '        Self { field: field.to_string(), message: message.to_string() }',
      '    }',
      '}',
      '',
      '/// Every error a service returns.',
      '#[derive(Debug)]',
      'pub enum DomainError {',
      '    /// No row has this key.',
      '    NotFound { entity: String, key: String },',
      '    /// The change clashes with what is stored: a unique value, a newer version, rows that depend on it.',
      '    Conflict { entity: String, reason: String, fields: Vec<String> },',
      '    /// The values break the rules of the table: missing, too long, out of range, pointing nowhere.',
      '    ValidationFailed { entity: String, errors: Vec<FieldError> },',
      '    /// The database failed for another reason.',
      '    Database(sea_orm::DbErr),',
      '}',
      '',
      'impl DomainError {',
      '    /// No row of entity has this key.',
      '    pub fn not_found(entity: &str, key: impl std::fmt::Debug) -> Self {',
      '        DomainError::NotFound { entity: entity.to_string(), key: format!("{key:?}") }',
      '    }',
      '',
      '    /// The change clashes with what is stored, on these fields.',
      '    pub fn conflict(entity: &str, reason: &str, fields: &[&str]) -> Self {',
      '        DomainError::Conflict {',
      '            entity: entity.to_string(),',
      '            reason: reason.to_string(),',
      '            fields: fields.iter().map(|field| field.to_string()).collect(),',
      '        }',
      '    }',
      '}',
      '',
      'impl std::fmt::Display for DomainError {',
      "    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
      '        match self {',
      '            DomainError::NotFound { entity, key } => write!(f, "No {entity} has the key {key}"),',
      '            DomainError::Conflict { entity, reason, .. } => write!(f, "{entity}: {reason}"),',
      '            DomainError::ValidationFailed { entity, errors } => {',
      '                let problems: Vec<String> = errors.iter().map(|error| format!("{}: {}", error.field, error.message)).collect();',
      '                write!(f, "{entity}: {}", problems.join("; "))',
      '            }',
      '            DomainError::Database(error) => write!(f, "{error}"),',
      '        }',
      '    }',
      '}',
      '',
      'impl std::error::Error for DomainError {}',
      '',
      'impl From<sea_orm::DbErr> for DomainError {',
      '    fn from(error: sea_orm::DbErr) -> Self {',
      '        DomainError::Database(error)',
      '    }',
      '}',
    ],
    ['The errors services return on purpose. They carry no HTTP codes: whoever calls the services translates them.'],
  )
}

export function commonFile(context: Context): GeneratedFile | null {
  const body: string[] = []
  if (context.settings.paging === 'offset')
    body.push(
      '/// A page of a list: the rows from an offset, and how many there are in all.',
      '#[derive(Debug, Clone, PartialEq)]',
      'pub struct Page<T> {',
      '    pub items: Vec<T>,',
      '    pub total: u64,',
      '    pub offset: u64,',
      '    pub limit: u64,',
      '}',
      '',
      'impl<T> Page<T> {',
      '    /// The same page with every row turned into something else.',
      '    pub fn map<R>(self, mapper: impl FnMut(T) -> R) -> Page<R> {',
      '        Page { items: self.items.into_iter().map(mapper).collect(), total: self.total, offset: self.offset, limit: self.limit }',
      '    }',
      '}',
    )
  if (context.settings.paging === 'cursor')
    body.push(
      '/// A page of a list read with a cursor: the rows after a key, and the key to read the next page from (None on the last page).',
      '#[derive(Debug, Clone, PartialEq)]',
      'pub struct CursorPage<T, K> {',
      '    pub items: Vec<T>,',
      '    pub next: Option<K>,',
      '}',
      '',
      'impl<T, K> CursorPage<T, K> {',
      '    /// The same page with every row turned into something else.',
      '    pub fn map<R>(self, mapper: impl FnMut(T) -> R) -> CursorPage<R, K> {',
      '        CursorPage { items: self.items.into_iter().map(mapper).collect(), next: self.next }',
      '    }',
      '}',
    )
  if (context.settings.services && context.settings.updates === 'patch')
    body.push(
      ...(body.length > 0 ? [''] : []),
      '/// A field of an update: absent (it keeps its value), or set to a value, which may be None.',
      '#[derive(Debug, Clone, PartialEq)]',
      'pub enum Patch<T> {',
      '    Absent,',
      '    Set(T),',
      '}',
      '',
      'impl<T> Default for Patch<T> {',
      '    fn default() -> Self {',
      '        Patch::Absent',
      '    }',
      '}',
      '',
      'impl<T> Patch<T> {',
      '    /// The value given, or None when the field is absent.',
      '    pub fn given(self) -> Option<T> {',
      '        match self {',
      '            Patch::Absent => None,',
      '            Patch::Set(value) => Some(value),',
      '        }',
      '    }',
      '}',
    )
  if (body.length === 0) return null
  return rsFile(fileOf(COMMON), '', body, ['What the services and repositories share: the pages lists are read in, and how updates come.'])
}

const URLS: Record<string, string> = {
  postgresql: 'postgres://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mysql://app:app@localhost:3306/app',
  sqlite: 'sqlite://app.db?mode=rwc',
}

export const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql

/** `database.rs`: the connection DATABASE_URL names, and Db, what repositories run their queries on. */
export function databaseFile(context: Context): GeneratedFile {
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

const HOW = {
  operation: 'Each service operation runs in a transaction of its own: begin() opens it, commit() keeps its changes.',
  caller: 'Services never commit: whoever holds the database opens the transaction (SqlUnitOfWork::in_transaction) and commits it.',
  repository: 'Every repository write is committed at once; services open no transaction.',
}

/** The type a unit of work hands a table's repository out as: its trait, or the database struct when there are none. */
export const repositoryHandle = (context: Context, info: TableInfo) =>
  context.settings.repositoryInterfaces ? `Box<dyn ${repositoryTrait(info)} + '_>` : `${sqlRepository(info)}<'_>`

/** UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork. */
export function unitOfWorkFile(context: Context): GeneratedFile {
  const settings = context.settings
  const interfaces = settings.repositoryInterfaces
  const memory = settings.memoryRepositories
  const uses = new RsUses().add(
    'async_trait::async_trait',
    'sea_orm::DatabaseConnection',
    'sea_orm::DatabaseTransaction',
    'sea_orm::TransactionTrait',
  )
  uses.add('crate::database::Db', DOMAIN_ERROR)
  for (const info of context.tables) {
    const module = moduleOf(context, info, 'repository')
    uses.add(pathIn(module, sqlRepository(info)))
    if (interfaces) uses.add(pathIn(module, repositoryTrait(info)))
    if (memory) uses.add(pathIn(module, memoryRepository(info)))
  }
  const accessor = (info: TableInfo) => `fn ${info.attr}(&self) -> ${repositoryHandle(context, info)}`
  const body = [
    `/// What services depend on: a repository per table and transactions. ${HOW[settings.transactions]}`,
    '#[async_trait]',
    'pub trait UnitOfWork: Send + Sync {',
    ...context.tables.map((info) => `    ${accessor(info)};`),
    '',
    '    /// A unit of work in a new transaction: its changes are kept when it is committed, and dropped otherwise.',
    '    async fn begin(&self) -> Result<Box<dyn UnitOfWork>, DomainError>;',
    '',
    '    /// Keeps the changes of the transaction this unit of work is in.',
    '    async fn commit(self: Box<Self>) -> Result<(), DomainError>;',
    '}',
    '',
    '/// The repositories over one database, and its transactions.',
    'pub struct SqlUnitOfWork {',
    '    db: Db,',
    '}',
    '',
    'impl SqlUnitOfWork {',
    '    /// The repositories over a connection: every write outside a transaction is committed at once.',
    '    pub fn new(connection: DatabaseConnection) -> Self {',
    '        Self { db: Db::Connection(connection) }',
    '    }',
    '',
    '    /// The repositories inside a transaction someone else opened; commit() commits it.',
    '    pub fn in_transaction(transaction: DatabaseTransaction) -> Self {',
    '        Self { db: Db::Transaction(transaction) }',
    '    }',
    '}',
    '',
    '#[async_trait]',
    'impl UnitOfWork for SqlUnitOfWork {',
    ...context.tables.flatMap((info) => [
      `    ${accessor(info)} {`,
      `        ${interfaces ? `Box::new(${sqlRepository(info)}::new(&self.db))` : `${sqlRepository(info)}::new(&self.db)`}`,
      '    }',
      '',
    ]),
    '    async fn begin(&self) -> Result<Box<dyn UnitOfWork>, DomainError> {',
    '        // Inside a transaction, a new one is a savepoint of it',
    '        let transaction = match &self.db {',
    '            Db::Connection(connection) => connection.begin().await?,',
    '            Db::Transaction(transaction) => transaction.begin().await?,',
    '        };',
    '        Ok(Box::new(SqlUnitOfWork::in_transaction(transaction)))',
    '    }',
    '',
    '    async fn commit(self: Box<Self>) -> Result<(), DomainError> {',
    '        if let Db::Transaction(transaction) = self.db {',
    '            transaction.commit().await?;',
    '        }',
    '        Ok(())',
    '    }',
    '}',
    ...(memory
      ? [
          '',
          '/// The in-memory repositories, for tests and for trying the services without a database. Memory has no',
          '/// transactions: changes are kept as they are made, and every copy of it shares the same rows.',
          '#[derive(Clone, Default)]',
          'pub struct MemoryUnitOfWork {',
          ...context.tables.map((info) => `    ${info.attr}: ${memoryRepository(info)},`),
          '}',
          '',
          '#[async_trait]',
          'impl UnitOfWork for MemoryUnitOfWork {',
          ...context.tables.flatMap((info) => [`    ${accessor(info)} {`, `        Box::new(self.${info.attr}.clone())`, '    }', '']),
          '    async fn begin(&self) -> Result<Box<dyn UnitOfWork>, DomainError> {',
          '        Ok(Box::new(self.clone()))',
          '    }',
          '',
          '    async fn commit(self: Box<Self>) -> Result<(), DomainError> {',
          '        Ok(())',
          '    }',
          '}',
        ]
      : []),
  ]
  return rsFile('src/unit_of_work.rs', uses.write(), body, [
    'The unit of work: the repositories of every table, and the transactions that group their writes.',
  ])
}
