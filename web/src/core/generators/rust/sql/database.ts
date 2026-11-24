/**
 * The database layer of a Rust project without an ORM: `database.rs`, with the sqlx pool of DATABASE_URL and Db, what the
 * repositories run their SQL on (the pool, or a transaction opened on it); how each column is selected, read and written;
 * and the entities, plain structs with a field per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { quoteName, typeSql } from '../../../schema/ddl.ts'
import type { Dialect } from '../../../schema/types.ts'
import { fileOf, moduleOf, rsFile, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { rsString } from '../rust.ts'
import { defaultUrl } from '../support.ts'

const isMysql = (database: Dialect) => database === 'mysql' || database === 'mariadb'

/** The names of sqlx for the kind of database: the pool, the database, the row and the result of a write. */
export function driverTypes(context: Context): { pool: string; database: string; row: string; result: string; feature: string } {
  const database = context.settings.database
  if (database === 'sqlite')
    return { pool: 'SqlitePool', database: 'Sqlite', row: 'SqliteRow', result: 'SqliteQueryResult', feature: 'sqlite' }
  if (isMysql(database)) return { pool: 'MySqlPool', database: 'MySql', row: 'MySqlRow', result: 'MySqlQueryResult', feature: 'mysql' }
  return { pool: 'PgPool', database: 'Postgres', row: 'PgRow', result: 'PgQueryResult', feature: 'postgres' }
}

const DOCS: Record<string, string> = { sqlite: 'sqlite', mysql: 'mysql', postgres: 'postgres' }

/** `insert_sql`: an insert of the columns given. */
function insertLines(context: Context): string[] {
  if (context.settings.database === 'postgresql')
    return [
      '/// An insert of the columns given, each one with the cast of its value; without any, of the defaults of the table.',
      'pub fn insert_sql(table: &str, given: &[(&str, &str)]) -> String {',
      '    if given.is_empty() {',
      '        return format!("INSERT INTO {table} DEFAULT VALUES");',
      '    }',
      '    let names: Vec<&str> = given.iter().map(|(name, _)| *name).collect();',
      '    let marks: Vec<String> = given.iter().enumerate().map(|(index, (_, cast))| format!("${}{cast}", index + 1)).collect();',
      '    format!("INSERT INTO {table} ({}) VALUES ({})", names.join(", "), marks.join(", "))',
      '}',
    ]
  return [
    '/// An insert of the columns given; without any, of the defaults of the table.',
    'pub fn insert_sql(table: &str, given: &[&str]) -> String {',
    '    if given.is_empty() {',
    `        return format!("INSERT INTO {table} ${context.settings.database === 'sqlite' ? 'DEFAULT VALUES' : '() VALUES ()'}");`,
    '    }',
    '    format!("INSERT INTO {table} ({}) VALUES ({})", given.join(", "), vec!["?"; given.len()].join(", "))',
    '}',
  ]
}

/** `database.rs`: the pool of DATABASE_URL, and Db, what repositories run their SQL on. */
export function databaseFile(context: Context): GeneratedFile {
  const types = driverTypes(context)
  const inserts = context.tables.some((info) => info.queries.some((item) => item.kind === 'insert'))
  return rsFile(
    'src/database.rs',
    ['use std::sync::Arc;', '', 'use sqlx::{Database, SqlSafeStr, Transaction};', 'use tokio::sync::Mutex;'].join('\n'),
    [
      `pub const DEFAULT_URL: &str = ${rsString(defaultUrl(context))};`,
      '',
      `pub type Pool = sqlx::${types.pool};`,
      `pub type Driver = sqlx::${types.database};`,
      `pub type DbRow = sqlx::${DOCS[types.feature]}::${types.row};`,
      `pub type DbResult = sqlx::${DOCS[types.feature]}::${types.result};`,
      '/// A statement with its values.',
      "pub type Query<'q> = sqlx::query::Query<'q, Driver, <Driver as Database>::Arguments>;",
      '',
      '/// A pool of connections to the database at DATABASE_URL (DEFAULT_URL when it is not set).',
      'pub async fn connect() -> Result<Pool, sqlx::Error> {',
      '    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());',
      '    Pool::connect(&url).await',
      '}',
      '',
      '/// What repositories run their SQL on: the pool, or a transaction opened on it.',
      'pub enum Db {',
      '    Pool(Pool),',
      "    Transaction(Arc<Mutex<Transaction<'static, Driver>>>),",
      '    /// A transaction another unit of work opened, and commits.',
      "    Joined(Arc<Mutex<Transaction<'static, Driver>>>),",
      '}',
      '',
      'impl Db {',
      '    /// Every row of a query.',
      "    pub async fn all(&self, query: Query<'_>) -> Result<Vec<DbRow>, sqlx::Error> {",
      '        match self {',
      '            Db::Pool(pool) => query.fetch_all(pool).await,',
      '            Db::Transaction(transaction) | Db::Joined(transaction) => query.fetch_all(&mut **transaction.lock().await).await,',
      '        }',
      '    }',
      '',
      '    /// The first row of a query, if there is one.',
      "    pub async fn one(&self, query: Query<'_>) -> Result<Option<DbRow>, sqlx::Error> {",
      '        match self {',
      '            Db::Pool(pool) => query.fetch_optional(pool).await,',
      '            Db::Transaction(transaction) | Db::Joined(transaction) => query.fetch_optional(&mut **transaction.lock().await).await,',
      '        }',
      '    }',
      '',
      '    /// Runs a statement that reads nothing back.',
      "    pub async fn run(&self, query: Query<'_>) -> Result<DbResult, sqlx::Error> {",
      '        match self {',
      '            Db::Pool(pool) => query.execute(pool).await,',
      '            Db::Transaction(transaction) | Db::Joined(transaction) => query.execute(&mut **transaction.lock().await).await,',
      '        }',
      '    }',
      '}',
      '',
      '/// A statement, whose values are bound to it in order. Its text is written by the repositories: no value is ever part of it.',
      "pub fn statement<'q>(sql: impl Into<String>) -> Query<'q> {",
      '    sqlx::query(sqlx::AssertSqlSafe(sql.into()).into_sql_str())',
      '}',
      ...(inserts ? ['', ...insertLines(context)] : []),
    ],
    ['The database DATABASE_URL names, through sqlx. It never migrates: the database already exists.'],
  )
}

/** The kinds sqlx takes and gives as text only through a cast of PostgreSQL. */
const AS_TEXT = new Set(['enum', 'json', 'array', 'unknown'])

/** `"status"::text`: a column as a read selects it. */
export function selected(context: Context, column: ColumnInfo): string {
  const name = quoteName(context.settings.database, column.column.name)
  const type = column.column.type
  if (context.settings.database === 'postgresql') {
    if (AS_TEXT.has(type.kind)) return `${name}::text`
    return type.kind === 'time' && type.timezone ? `${name}::time` : name
  }
  // sqlx has no decimals on SQLite: they are read from their text
  return context.settings.database === 'sqlite' && type.kind === 'decimal' ? `CAST(${name} AS TEXT)` : name
}

/** `::"mood"`: how PostgreSQL turns the text sent into the type of the column; nothing for the others. */
export function cast(context: Context, column: ColumnInfo): string {
  if (context.settings.database !== 'postgresql' || !AS_TEXT.has(column.column.type.kind)) return ''
  const type = column.column.type
  if (type.kind === 'enum') {
    const item = context.schema.enums.find((candidate) => candidate.name === type.name)
    return item?.storage === 'native' ? `::${quoteName('postgresql', type.name)}` : ''
  }
  return `::${typeSql(context.schema, 'postgresql', type)}`
}

const DATE_TIME = 'chrono::DateTime<chrono::FixedOffset>'

/** The type a value has for the driver, and how it becomes the one of the entity (`value` is the driver's). */
function driverValue(context: Context, column: ColumnInfo): { type: string; from: string | null; fallible?: boolean } {
  const database = context.settings.database
  if (column.rs === DATE_TIME) {
    // MySQL keeps no zone: the times are in UTC
    if (isMysql(database)) return { type: 'chrono::NaiveDateTime', from: 'value.and_utc().fixed_offset()' }
    return { type: 'chrono::DateTime<chrono::Utc>', from: 'value.fixed_offset()' }
  }
  if (column.rs === 'uuid::Uuid' && database !== 'postgresql') return { type: 'uuid::fmt::Hyphenated', from: 'value.into_uuid()' }
  if (column.rs === 'rust_decimal::Decimal' && database === 'sqlite') return { type: 'String', from: 'decimal', fallible: true }
  return { type: column.rs, from: null }
}

/** A column of a row, as the field of the entity keeps it. */
export function readColumn(context: Context, column: ColumnInfo, index: number): string {
  // The columns of MySQL and SQLite are of the type the schema says, whatever sqlx calls it
  const get = context.settings.database === 'postgresql' ? 'try_get' : 'try_get_unchecked'
  const { type, from, fallible } = driverValue(context, column)
  const read = `row.${get}::<Option<${type}>, _>(${index})?`
  if (from === null) return read
  if (fallible) {
    const scale = column.column.type.kind === 'decimal' ? column.column.type.scale : undefined
    return `${read}.map(|value| decimal(&value, ${scale === undefined ? 'None' : `Some(${scale})`})).transpose()?`
  }
  return `${read}.map(|value| ${from})`
}

/** A value of the entity's type, as the driver takes it. */
export function writeValue(context: Context, column: ColumnInfo, expression: string): string {
  const database = context.settings.database
  if (column.rs === DATE_TIME) return isMysql(database) ? `${expression}.naive_utc()` : `${expression}.with_timezone(&chrono::Utc)`
  if (column.rs === 'uuid::Uuid' && database !== 'postgresql') return `${expression}.hyphenated()`
  return column.rs === 'rust_decimal::Decimal' && database === 'sqlite' ? `${expression}.to_string()` : expression
}

/** Whether a table has a decimal SQLite keeps as a number. */
export const readsDecimals = (context: Context, info: TableInfo) =>
  context.settings.database === 'sqlite' && info.columns.some((column) => column.rs === 'rust_decimal::Decimal')

/** The entity of a table: a struct with a field per column, None until it is set or read. */
export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const comment = info.table.comment ? `: ${info.table.comment}` : ''
  const kept = context.settings.database === 'postgresql' ? ' (an array literal of PostgreSQL)' : ' (JSON)'
  const fields = info.columns.flatMap((column) => [
    ...(column.column.type.kind === 'unknown'
      ? [`    // TODO: "${column.column.type.sql}" has no Rust type here; it is kept as its text`]
      : []),
    ...(column.column.type.kind === 'array' ? [`    // TODO: "${column.column.type.sql}" is kept as its text${kept}`] : []),
    `    pub ${column.field}: Option<${column.rs}>,`,
  ])
  return rsFile(fileOf(moduleOf(context, info, 'entity')), '', [
    `/// A row of the "${info.name}" table${comment}. The repositories read and write it with SQL; a field stays \`None\` until it is set or read.`,
    '#[derive(Debug, Clone, Default, PartialEq)]',
    `pub struct ${info.entity} {`,
    ...fields,
    '}',
  ])
}
