/**
 * The database layer of a Python project without an ORM: the connection through each database's driver (psycopg 3,
 * MySQL Connector/Python, sqlite3), the helpers that run SQL and turn values from and to what the driver keeps, and
 * the entities, plain dataclasses with one attribute per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { Imports } from '../python.ts'
import { columnPyType, moduleOf, pathOf, writesEntities, type Context, type TableInfo } from '../common/context.ts'

export function defaultUrl(context: Context): string {
  const database = context.settings.database
  if (database === 'postgresql') return 'postgresql://app:app@localhost:5432/app'
  if (database === 'mysql' || database === 'mariadb') return `${database}://app:app@localhost:3306/app`
  return 'sqlite:///app.db'
}

/** The driver's name, for texts. */
export function driverLabel(context: Context): string {
  const database = context.settings.database
  if (database === 'postgresql') return 'psycopg'
  if (database === 'mysql' || database === 'mariadb') return 'MySQL Connector/Python'
  return 'sqlite3'
}

/** The mark of a parameter in the SQL: `%s` (psycopg, MySQL Connector) or `?` (sqlite3). */
export const mark = (context: Context) => (context.settings.database === 'sqlite' ? '?' : '%s')

/** app/db.py: the connection, the helpers that run SQL, and the values as the driver keeps them. */
export function dbFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const imports = new Imports().module('os').from('typing', 'Any').from('urllib.parse', 'unquote', 'urlsplit')
  const sqlite = database === 'sqlite'
  const postgres = database === 'postgresql'
  let connect: string[]
  if (postgres) {
    imports.module('psycopg').from('psycopg.types.json', 'Jsonb')
    connect = [
      'def connect(url: str = DATABASE_URL) -> Connection:',
      '    """A connection to the database at `url` (postgresql://user:password@host:port/name)."""',
      '    parts = urlsplit(url)',
      '    return psycopg.connect(parts._replace(scheme="postgresql").geturl())',
    ]
  } else if (sqlite) {
    imports.module('sqlite3')
    connect = [
      'def connect(url: str = DATABASE_URL) -> Connection:',
      '    """A connection to the database file at `url` (sqlite:///path), with foreign keys turned on."""',
      '    path = unquote(urlsplit(url).path)',
      '    # sqlite:///app.db is the file app.db; sqlite:////tmp/app.db is /tmp/app.db',
      '    connection = sqlite3.connect(path[1:] if path.startswith("/") else path)',
      '    connection.execute("PRAGMA foreign_keys = ON")',
      '    return connection',
    ]
  } else {
    imports.module('mysql.connector')
    connect = [
      'def connect(url: str = DATABASE_URL) -> Connection:',
      `    """A connection to the database at \`url\` (${database}://user:password@host:port/name)."""`,
      '    parts = urlsplit(url)',
      '    return mysql.connector.connect(',
      '        host=parts.hostname or "localhost",',
      '        port=parts.port or 3306,',
      '        user=unquote(parts.username or ""),',
      '        password=unquote(parts.password or ""),',
      '        database=parts.path.lstrip("/"),',
      '    )',
    ]
  }
  if (!postgres) imports.module('json')
  if (sqlite) imports.from('datetime', 'date', 'datetime', 'time').from('decimal', 'Decimal').from('uuid', 'UUID')
  else if (!postgres) imports.from('uuid', 'UUID')
  const content = lines(
    `"""The connection to the database through ${driverLabel(context)}, and the helpers the repositories run SQL with.`,
    '',
    'The URL comes from DATABASE_URL; see .env.example.',
    '"""',
    '',
    imports.write('app'),
    '',
    `DATABASE_URL = os.environ.get("DATABASE_URL", "${defaultUrl(context)}")`,
    '',
    postgres
      ? 'Connection = psycopg.Connection[tuple[Any, ...]]'
      : sqlite
        ? 'Connection = sqlite3.Connection'
        : '# What mysql.connector.connect() returns',
    !postgres && !sqlite && 'Connection = Any',
    '',
    `IntegrityError = ${postgres ? 'psycopg.IntegrityError' : sqlite ? 'sqlite3.IntegrityError' : 'mysql.connector.IntegrityError'}`,
    '"""What the database raises when it refuses a change: a unique value, a foreign key, a check."""',
    '',
    '',
    ...connect,
    '',
    '',
    'def fetch_one(connection: Connection, sql: str, params: tuple[Any, ...] = ()) -> tuple[Any, ...] | None:',
    '    """The first row of a query, or None."""',
    '    cursor = connection.cursor()',
    '    try:',
    '        cursor.execute(sql, params) if params else cursor.execute(sql)',
    '        row = cursor.fetchone()',
    '        return tuple(row) if row is not None else None',
    '    finally:',
    '        cursor.close()',
    '',
    '',
    'def fetch_all(connection: Connection, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:',
    '    """Every row of a query."""',
    '    cursor = connection.cursor()',
    '    try:',
    '        cursor.execute(sql, params) if params else cursor.execute(sql)',
    '        return [tuple(row) for row in cursor.fetchall()]',
    '    finally:',
    '        cursor.close()',
    '',
    '',
    'def execute(connection: Connection, sql: str, params: tuple[Any, ...] = ()) -> int | None:',
    '    """Runs a statement; the id the database gave the new row, when it numbers them."""',
    '    cursor = connection.cursor()',
    '    try:',
    // Without parameters the SQL is sent as it is: a % in it is not a parameter
    '        cursor.execute(sql, params) if params else cursor.execute(sql)',
    // psycopg reads new rows with RETURNING: its cursors keep no last id
    postgres ? '        return None' : '        return cursor.lastrowid',
    '    finally:',
    '        cursor.close()',
    '',
    '',
    'def to_db(value: Any) -> Any:',
    `    """A value as ${driverLabel(context)} writes it."""`,
    postgres
      ? ['    if isinstance(value, (dict, list)):', '        return Jsonb(value)', '    return value']
      : [
          '    if isinstance(value, (dict, list)):',
          '        return json.dumps(value)',
          '    if isinstance(value, UUID):',
          '        return str(value)',
          ...(sqlite
            ? [
                '    if isinstance(value, Decimal):',
                '        return str(value)',
                '    if isinstance(value, (datetime, date, time)):',
                '        return value.isoformat()',
              ]
            : []),
          '    return value',
        ],
    // What a driver hands back in another form than the entity's
    !postgres && [
      '',
      '',
      'def read_json(value: Any) -> Any:',
      '    """A JSON value: the driver gives its text."""',
      '    return json.loads(value) if isinstance(value, (str, bytes, bytearray)) else value',
      '',
      '',
      'def read_uuid(value: Any) -> Any:',
      '    """A UUID, kept as text."""',
      '    return UUID(str(value)) if value is not None and not isinstance(value, UUID) else value',
      '',
      '',
      'def read_bool(value: Any) -> Any:',
      '    """A boolean, kept as a number."""',
      '    return bool(value) if value is not None else None',
      '',
      '',
      'def read_bytes(value: Any) -> Any:',
      '    """Bytes, which the driver may give as a bytearray."""',
      '    return bytes(value) if value is not None else None',
    ],
    sqlite && [
      '',
      '',
      'def read_decimal(value: Any) -> Any:',
      '    """A decimal, which SQLite keeps as a number or a text."""',
      '    return Decimal(str(value)) if value is not None else None',
      '',
      '',
      'def read_datetime(value: Any) -> Any:',
      '    """A date and time, kept as ISO text."""',
      '    return datetime.fromisoformat(value) if isinstance(value, str) else value',
      '',
      '',
      'def read_date(value: Any) -> Any:',
      '    """A date, kept as ISO text."""',
      '    return date.fromisoformat(value) if isinstance(value, str) else value',
      '',
      '',
      'def read_time(value: Any) -> Any:',
      '    """A time of the day, kept as ISO text."""',
      '    return time.fromisoformat(value) if isinstance(value, str) else value',
    ],
    '',
  )
  return { path: 'app/db.py', content }
}

/** The reader a value of a column goes through, when the driver hands it in another form; null when it does not. */
export function readerOf(context: Context, kind: string): string | null {
  const database = context.settings.database
  if (database === 'postgresql') return null
  const sqlite = database === 'sqlite'
  switch (kind) {
    case 'json':
    case 'array':
      return 'read_json'
    case 'uuid':
      return 'read_uuid'
    case 'boolean':
      return 'read_bool'
    case 'binary':
      return 'read_bytes'
    case 'decimal':
      return sqlite ? 'read_decimal' : null
    case 'datetime':
      return sqlite ? 'read_datetime' : null
    case 'date':
      return sqlite ? 'read_date' : null
    case 'time':
      return sqlite ? 'read_time' : null
    default:
      return null
  }
}

/** The entity of a table: a dataclass with one attribute per column, None until it is set or read. */
export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const imports = new Imports().annotations().from('dataclasses', 'dataclass')
  const fields = info.columns.map((column) => `    ${column.attr}: ${columnPyType(column, imports, true)} = None`)
  const content = lines(
    `"""Entity of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}."""`,
    '',
    imports.write('app'),
    '',
    '',
    '@dataclass(kw_only=True)',
    `class ${info.entity}:`,
    `    """A row of the "${info.name}" table. An attribute stays None until it is set or read."""`,
    '',
    ...fields,
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'entity')), content }
}

export function databaseFiles(context: Context): GeneratedFile[] {
  return [
    dbFile(context),
    ...(writesEntities(context) ? context.tables.filter((info) => info.writesEntity).map((info) => entityFile(context, info)) : []),
  ]
}
