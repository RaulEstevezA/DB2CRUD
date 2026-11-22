"""The database layer of a TypeScript project without an ORM: src/database.ts, the database through each kind's driver
(node-postgres, mysql2, better-sqlite3) behind one small interface the repositories run their SQL on (every row of a
query, the first one, a statement, a transaction), its refusals, and the readers that turn what a driver gives back into
what the entities keep. The entities are the plain classes of common/entities.py. Mirrors
web/src/core/generators/typescript/sql/database.ts."""

from ...types import lines
from ..common.entities import plain_entity_file
from ..typescript import quote

LABELS = {"postgresql": "PostgreSQL", "mysql": "MySQL or MariaDB", "sqlite": "SQLite"}

# The driver's name, for texts
DRIVER_LABELS = {"postgresql": "node-postgres", "mysql": "mysql2", "sqlite": "better-sqlite3"}

_URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mariadb://app:app@localhost:3306/app",
    "sqlite": "file:./app.db",
}


def dialect_of(context: dict) -> str:
    """The three kinds of database the drivers speak to: MariaDB through the MySQL driver."""
    database = context["settings"]["database"]
    if database in ("mariadb", "mysql"):
        return "mysql"
    return "sqlite" if database == "sqlite" else "postgresql"


def default_url(context: dict) -> str:
    return _URLS.get(context["settings"]["database"], _URLS["postgresql"])


def mark(context: dict, index: int) -> str:
    """The mark of the `index`-th parameter (from 0) in the SQL: $1 (node-postgres) or ?."""
    return f"${index + 1}" if dialect_of(context) == "postgresql" else "?"


# The interface every database of the project has, whatever its driver
_INTERFACE = [
    "/** A row as the driver gives it: its values by column name. */",
    "export type Row = Record<string, unknown>",
    "",
    "/** What the repositories run their SQL on: the database, or one of its transactions. */",
    "export interface Db {",
    "  /** Every row of a query. */",
    "  all(sql: string, params?: unknown[]): Promise<Row[]>",
    "  /** The first row of a query, or null. */",
    "  one(sql: string, params?: unknown[]): Promise<Row | null>",
    "  /** Runs a statement; the id the database gave the new row, when it numbers them. */",
    "  run(sql: string, params?: unknown[]): Promise<number | null>",
    "  /** Runs `work` in a transaction: committed when it ends, rolled back when it throws. Inside one, it joins it. */",
    "  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>",
    "}",
    "",
    "/** The database itself: a Db that close() ends. */",
    "export interface Database extends Db {",
    "  close(): Promise<void>",
    "}",
]

# The implementation of Db over each driver, and how the database is opened.
_DRIVERS = {
    "postgresql": {
        "imports": ["import pg from 'pg'"],
        "body": [
            "// Whole numbers of 64 bits as numbers, and dates without a time as their text, as the entities keep them",
            "// pg-types names only the scalar types: the parsers of arrays are reached by their number",
            "const parserOf = pg.types.getTypeParser as (oid: number, format?: string) => (value: string) => unknown",
            "const TEXT_ARRAY = 1009",
            "const TYPES: pg.CustomTypesConfig = {",
            "  getTypeParser: ((oid: number, format?: string) => {",
            "    if (oid === pg.types.builtins.INT8) return (value: string) => Number(value)",
            "    if (oid === pg.types.builtins.DATE) return (value: string) => value",
            "    // Their arrays (bigint[], date[]), read as text[] first",
            "    if (oid === 1016) return (value: string) => (parserOf(TEXT_ARRAY)(value) as string[]).map(Number)",
            "    if (oid === 1182) return parserOf(TEXT_ARRAY)",
            "    return parserOf(oid, format)",
            "  }) as pg.CustomTypesConfig['getTypeParser'],",
            "}",
            "",
            "/** A Db over the pool, or over the one connection of a transaction. */",
            "class PgDb implements Database {",
            "  constructor(",
            "    private readonly client: pg.Pool | pg.PoolClient,",
            "    private readonly inTransaction = false,",
            "  ) {}",
            "",
            "  async all(sql: string, params: unknown[] = []): Promise<Row[]> {",
            "    return (await this.client.query<Row>(sql, params)).rows",
            "  }",
            "",
            "  async one(sql: string, params: unknown[] = []): Promise<Row | null> {",
            "    return (await this.client.query<Row>(sql, params)).rows[0] ?? null",
            "  }",
            "",
            "  async run(sql: string, params: unknown[] = []): Promise<number | null> {",
            "    // PostgreSQL gives new rows back with RETURNING: it keeps no last id",
            "    await this.client.query(sql, params)",
            "    return null",
            "  }",
            "",
            "  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {",
            "    if (this.inTransaction) return work(this)",
            "    const connection = await (this.client as pg.Pool).connect()",
            "    try {",
            "      await connection.query('BEGIN')",
            "      const result = await work(new PgDb(connection, true))",
            "      await connection.query('COMMIT')",
            "      return result",
            "    } catch (error) {",
            "      await connection.query('ROLLBACK')",
            "      throw error",
            "    } finally {",
            "      connection.release()",
            "    }",
            "  }",
            "",
            "  async close(): Promise<void> {",
            "    await (this.client as pg.Pool).end()",
            "  }",
            "}",
            "",
            "/** The PostgreSQL database at `url` (postgresql://user:password@host:port/name), through a pool of connections. */",
            "export function createDatabase(url: string = DATABASE_URL): Database {",
            "  return new PgDb(new pg.Pool({ connectionString: url, types: TYPES }))",
            "}",
            "",
            "/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
            "export function isRefusal(error: unknown): boolean {",
            "  // SQLSTATE class 23: integrity constraint violation",
            "  const code = (error as { code?: unknown } | null)?.code",
            "  return typeof code === 'string' && code.startsWith('23')",
            "}",
        ],
    },
    "mysql": {
        "imports": ["import mysql from 'mysql2/promise'"],
        "body": [
            "/** A Db over the pool, or over the one connection of a transaction. */",
            "class MysqlDb implements Database {",
            "  constructor(",
            "    private readonly client: mysql.Pool | mysql.PoolConnection,",
            "    private readonly inTransaction = false,",
            "  ) {}",
            "",
            "  async all(sql: string, params: unknown[] = []): Promise<Row[]> {",
            "    const [rows] = await this.client.query<mysql.RowDataPacket[]>(sql, bind(params))",
            "    return rows",
            "  }",
            "",
            "  async one(sql: string, params: unknown[] = []): Promise<Row | null> {",
            "    return (await this.all(sql, params))[0] ?? null",
            "  }",
            "",
            "  async run(sql: string, params: unknown[] = []): Promise<number | null> {",
            "    const [result] = await this.client.query<mysql.ResultSetHeader>(sql, bind(params))",
            "    return result.insertId || null",
            "  }",
            "",
            "  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {",
            "    if (this.inTransaction) return work(this)",
            "    const connection = await (this.client as mysql.Pool).getConnection()",
            "    try {",
            "      await connection.beginTransaction()",
            "      const result = await work(new MysqlDb(connection, true))",
            "      await connection.commit()",
            "      return result",
            "    } catch (error) {",
            "      await connection.rollback()",
            "      throw error",
            "    } finally {",
            "      connection.release()",
            "    }",
            "  }",
            "",
            "  async close(): Promise<void> {",
            "    await (this.client as mysql.Pool).end()",
            "  }",
            "}",
            "",
            "/** The values of a statement as mysql2 writes them: undefined is NULL. */",
            "function bind(params: unknown[]): unknown[] {",
            "  return params.map((value) => (value === undefined ? null : value))",
            "}",
            "",
            "/** The MySQL or MariaDB database at `url` (mysql:// or mariadb://user:password@host:port/name), through a pool of connections. */",
            "export function createDatabase(url: string = DATABASE_URL): Database {",
            "  const uri = url.replace(/^mariadb:/, 'mysql:')",
            "  // Whole numbers come back as numbers, dates without a time and JSON as their text, and times in UTC",
            "  return new MysqlDb(",
            "    mysql.createPool({ uri, supportBigNumbers: true, bigNumberStrings: false, dateStrings: ['DATE'], jsonStrings: true, timezone: 'Z' }),",
            "  )",
            "}",
            "",
            "/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
            "export function isRefusal(error: unknown): boolean {",
            "  const { sqlState, errno } = (error ?? {}) as { sqlState?: unknown; errno?: unknown }",
            "  // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819)",
            "  return (typeof sqlState === 'string' && sqlState.startsWith('23')) || errno === 3819",
            "}",
        ],
    },
    "sqlite": {
        "imports": ["import BetterSqlite3 from 'better-sqlite3'"],
        "body": [
            "/** A Db over the one connection SQLite has: transactions run on it too. */",
            "class SqliteDb implements Database {",
            "  constructor(",
            "    private readonly client: BetterSqlite3.Database,",
            "    private readonly inTransaction = false,",
            "  ) {}",
            "",
            "  async all(sql: string, params: unknown[] = []): Promise<Row[]> {",
            "    return this.client.prepare(sql).all(...bind(params)) as Row[]",
            "  }",
            "",
            "  async one(sql: string, params: unknown[] = []): Promise<Row | null> {",
            "    return (this.client.prepare(sql).get(...bind(params)) as Row | undefined) ?? null",
            "  }",
            "",
            "  async run(sql: string, params: unknown[] = []): Promise<number | null> {",
            "    return Number(this.client.prepare(sql).run(...bind(params)).lastInsertRowid)",
            "  }",
            "",
            "  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {",
            "    if (this.inTransaction) return work(this)",
            "    this.client.exec('BEGIN')",
            "    try {",
            "      const result = await work(new SqliteDb(this.client, true))",
            "      this.client.exec('COMMIT')",
            "      return result",
            "    } catch (error) {",
            "      this.client.exec('ROLLBACK')",
            "      throw error",
            "    }",
            "  }",
            "",
            "  async close(): Promise<void> {",
            "    this.client.close()",
            "  }",
            "}",
            "",
            "/** The values of a statement as SQLite keeps them: dates as ISO text, booleans as 1 and 0, undefined as NULL. */",
            "function bind(params: unknown[]): unknown[] {",
            "  return params.map((value) => {",
            "    if (value === undefined) return null",
            "    if (value instanceof Date) return value.toISOString()",
            "    if (typeof value === 'boolean') return value ? 1 : 0",
            "    return value",
            "  })",
            "}",
            "",
            "/** The SQLite database at `url` (file:<path>, or file::memory: for one in memory), with foreign keys turned on. */",
            "export function createDatabase(url: string = DATABASE_URL): Database {",
            "  const file = url.replace(/^file:/, '')",
            "  const client = new BetterSqlite3(file === '' || file === ':memory:' ? ':memory:' : file)",
            "  // SQLite checks foreign keys only when asked to",
            "  client.pragma('foreign_keys = ON')",
            "  return new SqliteDb(client)",
            "}",
            "",
            "/** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
            "export function isRefusal(error: unknown): boolean {",
            "  const code = (error as { code?: unknown } | null)?.code",
            "  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')",
            "}",
        ],
    },
}


def _reader_name(dialect: str, type_: dict) -> str | None:
    """The reader a value of a kind goes through on each database, when the driver gives it in another form."""
    mysql = dialect == "mysql"
    sqlite = dialect == "sqlite"
    kind = type_["kind"]
    if kind == "json":
        return "fromJson"
    if kind == "array":
        return None if dialect == "postgresql" else "fromJson"
    if kind == "boolean":
        return "fromBoolean" if mysql or sqlite else None
    if kind == "decimal":
        return "fromDecimal" if mysql or sqlite else None
    if kind == "datetime":
        return "fromDatetime" if sqlite else None
    if kind == "binary":
        return "fromBytes" if mysql or sqlite else None
    return None


def read_value(context: dict, type_: dict, value: str) -> tuple[str, str | None]:
    """The expression that reads a value of a column from a row, through its reader when it needs one."""
    reader = _reader_name(dialect_of(context), type_)
    if reader is None:
        return value, None
    # A decimal is kept with the digits its scale gives
    scale = f", {type_['scale']}" if reader == "fromDecimal" and type_.get("scale") is not None else ""
    return f"{reader}({value}{scale})", reader


def writes_json(context: dict, type_: dict) -> bool:
    """Whether a value of the type is written as JSON text: JSON everywhere (node-postgres would write a list as an
    array), lists where the database has no arrays."""
    return type_["kind"] == "json" or (type_["kind"] == "array" and dialect_of(context) != "postgresql")


# The readers of src/database.ts, each written only when some column needs it
_READERS = {
    "fromJson": [
        "/** A JSON value, from its text. */",
        "export function fromJson(value: unknown): unknown {",
        "  return typeof value === 'string' ? JSON.parse(value) : value",
        "}",
    ],
    "fromBoolean": [
        "/** A boolean, kept as a number. */",
        "export function fromBoolean(value: unknown): boolean | null {",
        "  return value === null || value === undefined ? null : Number(value) !== 0",
        "}",
    ],
    "fromDecimal": [
        "/** An exact decimal as text, with `scale` digits after the point: the database may give it as a number. */",
        "export function fromDecimal(value: unknown, scale?: number): string | null {",
        "  if (value === null || value === undefined) return null",
        "  if (typeof value === 'number') return scale === undefined ? String(value) : value.toFixed(scale)",
        "  return String(value)",
        "}",
    ],
    "fromDatetime": [
        "/** A date and time, kept as ISO text; one without its zone is in UTC (CURRENT_TIMESTAMP). */",
        "export function fromDatetime(value: unknown): Date | null {",
        "  if (value === null || value === undefined) return null",
        "  if (value instanceof Date) return value",
        "  const text = String(value)",
        "  return new Date(/(z|[+-]\\d\\d:?\\d\\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`)",
        "}",
    ],
    "fromBytes": [
        "/** Bytes, as a Buffer. */",
        "export function fromBytes(value: unknown): Buffer | null {",
        "  if (value === null || value === undefined) return null",
        "  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)",
        "}",
    ],
}


def _database_file(context: dict) -> dict:
    """src/database.ts: the database DATABASE_URL names, the interface the repositories run SQL on, its refusals and
    the readers."""
    dialect = dialect_of(context)
    driver = _DRIVERS[dialect]
    used = set()
    for info in context["tables"]:
        for column in info["columns"]:
            reader = _reader_name(dialect, column["column"]["type"])
            if reader:
                used.add(reader)
    json = any(
        writes_json(context, column["column"]["type"]) for info in context["tables"] for column in info["columns"]
    )
    readers = [name for name in _READERS if name in used]
    content = lines(
        f"/** The {LABELS[dialect]} database DATABASE_URL names (see .env.example), through {DRIVER_LABELS[dialect]}, "
        "and the calls the repositories run SQL with. */",
        *driver["imports"],
        "",
        f"export const DATABASE_URL = process.env.DATABASE_URL ?? {quote(default_url(context))}",
        "",
        *_INTERFACE,
        "",
        *driver["body"],
        json
        and [
            "",
            "/** A value as JSON text, for the columns kept as JSON. */",
            "export function toJson(value: unknown): string | null {",
            "  return value === null || value === undefined ? null : JSON.stringify(value)",
            "}",
        ],
        *(["", *_READERS[name]] for name in readers),
        "",
    )
    return {"path": "src/database.ts", "content": content}


def database_files(context: dict) -> list[dict]:
    return [
        _database_file(context),
        *(
            plain_entity_file(context, info, "The repositories read and write it with SQL.")
            for info in context["tables"]
            if info["writesEntity"]
        ),
    ]
