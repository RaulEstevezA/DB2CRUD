/**
 * The database layer of a TypeScript project without an ORM: `src/database.ts`, the database through each kind's
 * driver (node-postgres, mysql2, better-sqlite3) behind one small interface the repositories run their SQL on (every
 * row of a query, the first one, a statement, a transaction), its refusals, and the readers that turn what a driver
 * gives back into what the entities keep. The entities are the plain classes of common/entities.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbType } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { quote } from '../typescript.ts'
import { plainEntityFile } from '../common/entities.ts'
import type { Context } from '../common/context.ts'

/** The three kinds of database the drivers speak to: MariaDB through the MySQL driver. */
export type Dialect = 'postgresql' | 'mysql' | 'sqlite'

export function dialectOf(context: Context): Dialect {
  const database = context.settings.database
  return database === 'mariadb' || database === 'mysql' ? 'mysql' : database === 'sqlite' ? 'sqlite' : 'postgresql'
}

export const LABELS: Record<Dialect, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL or MariaDB', sqlite: 'SQLite' }

/** The driver's name, for texts. */
export const DRIVER_LABELS: Record<Dialect, string> = { postgresql: 'node-postgres', mysql: 'mysql2', sqlite: 'better-sqlite3' }

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mariadb://app:app@localhost:3306/app',
  sqlite: 'file:./app.db',
}

export const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql

/** The mark of the `index`-th parameter (from 0) in the SQL: `$1` (node-postgres) or `?`. */
export const mark = (context: Context, index: number) => (dialectOf(context) === 'postgresql' ? `$${index + 1}` : '?')

/** The interface every database of the project has, whatever its driver. */
const INTERFACE: Line[] = [
  '/** A row as the driver gives it: its values by column name. */',
  'export type Row = Record<string, unknown>',
  '',
  '/** What the repositories run their SQL on: the database, or one of its transactions. */',
  'export interface Db {',
  '  /** Every row of a query. */',
  '  all(sql: string, params?: unknown[]): Promise<Row[]>',
  '  /** The first row of a query, or null. */',
  '  one(sql: string, params?: unknown[]): Promise<Row | null>',
  '  /** Runs a statement; the id the database gave the new row, when it numbers them. */',
  '  run(sql: string, params?: unknown[]): Promise<number | null>',
  '  /** Runs `work` in a transaction: committed when it ends, rolled back when it throws. Inside one, it joins it. */',
  '  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>',
  '}',
  '',
  '/** The database itself: a Db that close() ends. */',
  'export interface Database extends Db {',
  '  close(): Promise<void>',
  '}',
]

/** The implementation of Db over each driver, and how the database is opened. */
const DRIVERS: Record<Dialect, { imports: string[]; body: Line[] }> = {
  postgresql: {
    imports: ["import pg from 'pg'"],
    body: [
      '// Whole numbers of 64 bits as numbers, and dates without a time as their text, as the entities keep them',
      'const TYPES: pg.CustomTypesConfig = {',
      '  getTypeParser: ((oid: number, format?: string) => {',
      '    if (oid === pg.types.builtins.INT8) return (value: string) => Number(value)',
      '    if (oid === pg.types.builtins.DATE) return (value: string) => value',
      '    // Their arrays: bigint[] and date[]',
      '    if (oid === 1016) return (value: string) => (pg.types.getTypeParser(1009)(value) as string[]).map(Number)',
      '    if (oid === 1182) return pg.types.getTypeParser(1009)',
      "    return pg.types.getTypeParser(oid, format as 'text')",
      "  }) as pg.CustomTypesConfig['getTypeParser'],",
      '}',
      '',
      '/** A Db over the pool, or over the one connection of a transaction. */',
      'class PgDb implements Database {',
      '  constructor(',
      '    private readonly client: pg.Pool | pg.PoolClient,',
      '    private readonly inTransaction = false,',
      '  ) {}',
      '',
      '  async all(sql: string, params: unknown[] = []): Promise<Row[]> {',
      '    return (await this.client.query<Row>(sql, params)).rows',
      '  }',
      '',
      '  async one(sql: string, params: unknown[] = []): Promise<Row | null> {',
      '    return (await this.client.query<Row>(sql, params)).rows[0] ?? null',
      '  }',
      '',
      '  async run(sql: string, params: unknown[] = []): Promise<number | null> {',
      '    // PostgreSQL gives new rows back with RETURNING: it keeps no last id',
      '    await this.client.query(sql, params)',
      '    return null',
      '  }',
      '',
      '  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {',
      '    if (this.inTransaction) return work(this)',
      '    const connection = await (this.client as pg.Pool).connect()',
      '    try {',
      "      await connection.query('BEGIN')",
      '      const result = await work(new PgDb(connection, true))',
      "      await connection.query('COMMIT')",
      '      return result',
      '    } catch (error) {',
      "      await connection.query('ROLLBACK')",
      '      throw error',
      '    } finally {',
      '      connection.release()',
      '    }',
      '  }',
      '',
      '  async close(): Promise<void> {',
      '    await (this.client as pg.Pool).end()',
      '  }',
      '}',
      '',
      '/** The PostgreSQL database at `url` (postgresql://user:password@host:port/name), through a pool of connections. */',
      'export function createDatabase(url: string = DATABASE_URL): Database {',
      '  return new PgDb(new pg.Pool({ connectionString: url, types: TYPES }))',
      '}',
      '',
      '/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
      'export function isRefusal(error: unknown): boolean {',
      '  // SQLSTATE class 23: integrity constraint violation',
      '  const code = (error as { code?: unknown } | null)?.code',
      "  return typeof code === 'string' && code.startsWith('23')",
      '}',
    ],
  },
  mysql: {
    imports: ["import mysql from 'mysql2/promise'"],
    body: [
      '/** A Db over the pool, or over the one connection of a transaction. */',
      'class MysqlDb implements Database {',
      '  constructor(',
      '    private readonly client: mysql.Pool | mysql.PoolConnection,',
      '    private readonly inTransaction = false,',
      '  ) {}',
      '',
      '  async all(sql: string, params: unknown[] = []): Promise<Row[]> {',
      '    const [rows] = await this.client.query<mysql.RowDataPacket[]>(sql, bind(params))',
      '    return rows',
      '  }',
      '',
      '  async one(sql: string, params: unknown[] = []): Promise<Row | null> {',
      '    return (await this.all(sql, params))[0] ?? null',
      '  }',
      '',
      '  async run(sql: string, params: unknown[] = []): Promise<number | null> {',
      '    const [result] = await this.client.query<mysql.ResultSetHeader>(sql, bind(params))',
      '    return result.insertId || null',
      '  }',
      '',
      '  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {',
      '    if (this.inTransaction) return work(this)',
      '    const connection = await (this.client as mysql.Pool).getConnection()',
      '    try {',
      '      await connection.beginTransaction()',
      '      const result = await work(new MysqlDb(connection, true))',
      '      await connection.commit()',
      '      return result',
      '    } catch (error) {',
      '      await connection.rollback()',
      '      throw error',
      '    } finally {',
      '      connection.release()',
      '    }',
      '  }',
      '',
      '  async close(): Promise<void> {',
      '    await (this.client as mysql.Pool).end()',
      '  }',
      '}',
      '',
      '/** The values of a statement as mysql2 writes them: undefined is NULL. */',
      'function bind(params: unknown[]): unknown[] {',
      '  return params.map((value) => (value === undefined ? null : value))',
      '}',
      '',
      '/** The MySQL or MariaDB database at `url` (mysql:// or mariadb://user:password@host:port/name), through a pool of connections. */',
      'export function createDatabase(url: string = DATABASE_URL): Database {',
      "  const uri = url.replace(/^mariadb:/, 'mysql:')",
      '  // Whole numbers come back as numbers, dates without a time and JSON as their text, and times in UTC',
      '  return new MysqlDb(',
      "    mysql.createPool({ uri, supportBigNumbers: true, bigNumberStrings: false, dateStrings: ['DATE'], jsonStrings: true, timezone: 'Z' }),",
      '  )',
      '}',
      '',
      '/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
      'export function isRefusal(error: unknown): boolean {',
      '  const { sqlState, errno } = (error ?? {}) as { sqlState?: unknown; errno?: unknown }',
      '  // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819)',
      "  return (typeof sqlState === 'string' && sqlState.startsWith('23')) || errno === 3819",
      '}',
    ],
  },
  sqlite: {
    imports: ["import BetterSqlite3 from 'better-sqlite3'"],
    body: [
      '/** A Db over the one connection SQLite has: transactions run on it too. */',
      'class SqliteDb implements Database {',
      '  constructor(',
      '    private readonly client: BetterSqlite3.Database,',
      '    private readonly inTransaction = false,',
      '  ) {}',
      '',
      '  async all(sql: string, params: unknown[] = []): Promise<Row[]> {',
      '    return this.client.prepare(sql).all(...bind(params)) as Row[]',
      '  }',
      '',
      '  async one(sql: string, params: unknown[] = []): Promise<Row | null> {',
      '    return (this.client.prepare(sql).get(...bind(params)) as Row | undefined) ?? null',
      '  }',
      '',
      '  async run(sql: string, params: unknown[] = []): Promise<number | null> {',
      '    return Number(this.client.prepare(sql).run(...bind(params)).lastInsertRowid)',
      '  }',
      '',
      '  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {',
      '    if (this.inTransaction) return work(this)',
      "    this.client.exec('BEGIN')",
      '    try {',
      '      const result = await work(new SqliteDb(this.client, true))',
      "      this.client.exec('COMMIT')",
      '      return result',
      '    } catch (error) {',
      "      this.client.exec('ROLLBACK')",
      '      throw error',
      '    }',
      '  }',
      '',
      '  async close(): Promise<void> {',
      '    this.client.close()',
      '  }',
      '}',
      '',
      '/** The values of a statement as SQLite keeps them: dates as ISO text, booleans as 1 and 0, undefined as NULL. */',
      'function bind(params: unknown[]): unknown[] {',
      '  return params.map((value) => {',
      '    if (value === undefined) return null',
      '    if (value instanceof Date) return value.toISOString()',
      "    if (typeof value === 'boolean') return value ? 1 : 0",
      '    return value',
      '  })',
      '}',
      '',
      '/** The SQLite database at `url` (file:<path>, or file::memory: for one in memory), with foreign keys turned on. */',
      'export function createDatabase(url: string = DATABASE_URL): Database {',
      "  const file = url.replace(/^file:/, '')",
      "  const client = new BetterSqlite3(file === '' || file === ':memory:' ? ':memory:' : file)",
      '  // SQLite checks foreign keys only when asked to',
      "  client.pragma('foreign_keys = ON')",
      '  return new SqliteDb(client)',
      '}',
      '',
      '/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
      'export function isRefusal(error: unknown): boolean {',
      '  const code = (error as { code?: unknown } | null)?.code',
      "  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')",
      '}',
    ],
  },
}

/** The readers a value of a kind goes through on each database, when the driver gives it in another form. */
function readerName(dialect: Dialect, type: DbType): string | null {
  const mysql = dialect === 'mysql'
  const sqlite = dialect === 'sqlite'
  switch (type.kind) {
    case 'json':
      return 'fromJson'
    case 'array':
      return dialect === 'postgresql' ? null : 'fromJson'
    case 'boolean':
      return mysql || sqlite ? 'fromBoolean' : null
    case 'decimal':
      return mysql || sqlite ? 'fromDecimal' : null
    case 'datetime':
      return sqlite ? 'fromDatetime' : null
    case 'binary':
      return mysql || sqlite ? 'fromBytes' : null
    default:
      return null
  }
}

/** The expression that reads a value of a column from a row, through its reader when it needs one. */
export function readValue(context: Context, type: DbType, value: string): { expression: string; reader: string | null } {
  const reader = readerName(dialectOf(context), type)
  if (reader === null) return { expression: value, reader }
  // A decimal is kept with the digits its scale gives
  const scale = reader === 'fromDecimal' && type.kind === 'decimal' && type.scale !== undefined ? `, ${type.scale}` : ''
  return { expression: `${reader}(${value}${scale})`, reader }
}

/** Whether a value of the type is written as JSON text: JSON everywhere (node-postgres would write a list as an
 * array), lists where the database has no arrays. */
export const writesJson = (context: Context, type: DbType) =>
  type.kind === 'json' || (type.kind === 'array' && dialectOf(context) !== 'postgresql')

/** The readers of src/database.ts, each written only when some column needs it. */
const READERS: Record<string, Line[]> = {
  fromJson: [
    '/** A JSON value, from its text. */',
    'export function fromJson(value: unknown): unknown {',
    "  return typeof value === 'string' ? JSON.parse(value) : value",
    '}',
  ],
  fromBoolean: [
    '/** A boolean, kept as a number. */',
    'export function fromBoolean(value: unknown): boolean | null {',
    '  return value === null || value === undefined ? null : Number(value) !== 0',
    '}',
  ],
  fromDecimal: [
    '/** An exact decimal as text, with `scale` digits after the point: the database may give it as a number. */',
    'export function fromDecimal(value: unknown, scale?: number): string | null {',
    '  if (value === null || value === undefined) return null',
    "  if (typeof value === 'number') return scale === undefined ? String(value) : value.toFixed(scale)",
    '  return String(value)',
    '}',
  ],
  fromDatetime: [
    '/** A date and time, kept as ISO text; one without its zone is in UTC (CURRENT_TIMESTAMP). */',
    'export function fromDatetime(value: unknown): Date | null {',
    '  if (value === null || value === undefined) return null',
    '  if (value instanceof Date) return value',
    '  const text = String(value)',
    "  return new Date(/(z|[+-]\\d\\d:?\\d\\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`)",
    '}',
  ],
  fromBytes: [
    '/** Bytes, as a Buffer. */',
    'export function fromBytes(value: unknown): Buffer | null {',
    '  if (value === null || value === undefined) return null',
    '  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)',
    '}',
  ],
}

/** `src/database.ts`: the database DATABASE_URL names, the interface the repositories run SQL on, its refusals and the readers. */
function databaseFile(context: Context): GeneratedFile {
  const dialect = dialectOf(context)
  const driver = DRIVERS[dialect]
  const used = new Set<string>()
  for (const info of context.tables)
    for (const column of info.columns) {
      const reader = readerName(dialect, column.column.type)
      if (reader) used.add(reader)
    }
  const json = context.tables.some((info) => info.columns.some((column) => writesJson(context, column.column.type)))
  const readers = Object.keys(READERS).filter((name) => used.has(name))
  return {
    path: 'src/database.ts',
    content: lines(
      `/** The ${LABELS[dialect]} database DATABASE_URL names (see .env.example), through ${DRIVER_LABELS[dialect]}, and the calls the repositories run SQL with. */`,
      ...driver.imports,
      '',
      `export const DATABASE_URL = process.env.DATABASE_URL ?? ${quote(defaultUrl(context))}`,
      '',
      ...INTERFACE,
      '',
      ...driver.body,
      json && [
        '',
        '/** A value as JSON text, for the columns kept as JSON. */',
        'export function toJson(value: unknown): string | null {',
        '  return value === null || value === undefined ? null : JSON.stringify(value)',
        '}',
      ],
      ...readers.flatMap((name) => ['', ...READERS[name]]),
      '',
    ),
  }
}

export function databaseFiles(context: Context): GeneratedFile[] {
  return [
    databaseFile(context),
    ...context.tables
      .filter((info) => info.writesEntity)
      .map((info) => plainEntityFile(context, info, 'The repositories read and write it with SQL.')),
  ]
}
