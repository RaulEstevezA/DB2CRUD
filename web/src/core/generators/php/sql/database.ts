/**
 * The database layer of a PHP project without an ORM: `Database`, which opens the database DATABASE_URL names with PDO;
 * `Sql`, what the repositories run their SQL with (statements and their values as each driver takes them, and the
 * database's refusals); and the entities, plain classes with a property per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbType } from '../../../schema/types.ts'
import type { Line } from '../../types.ts'
import { className, namespaceOf, optionalType, pathOf, phpFile, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { phpString, PhpUses } from '../common/php.ts'

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mariadb://app:app@localhost:3306/app',
  sqlite: 'sqlite:///app.db',
}

export const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql
const isMysql = (context: Context) => context.settings.database === 'mysql' || context.settings.database === 'mariadb'

/** The PHP type of a value as the entities keep it. */
export function sqlPhpType(type: DbType): string {
  switch (type.kind) {
    case 'integer':
      return 'int'
    case 'float':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'date':
    case 'datetime':
      return '\\DateTimeImmutable'
    case 'json':
    case 'array':
      return 'mixed'
    default:
      return 'string'
  }
}

/** `Database`: the PDO connection to the database DATABASE_URL names. */
function databaseFile(context: Context): GeneratedFile {
  const sqlite = context.settings.database === 'sqlite'
  const options = [
    '            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,',
    '            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_NUM,',
    ...(isMysql(context) ? ['            // Numbers come back as numbers', '            PDO::ATTR_EMULATE_PREPARES => false,'] : []),
  ]
  const connect = sqlite
    ? [
        "        $path = substr($url, strlen('sqlite:///'));",
        "        $db = new PDO('sqlite:' . ($path !== '' ? $path : ':memory:'), null, null, [",
        ...options,
        '        ]);',
        "        $db->exec('PRAGMA foreign_keys = ON');",
        '        return $db;',
      ]
    : [
        '        $parts = parse_url($url);',
        "        if ($parts === false || !isset($parts['host'], $parts['path'])) {",
        "            throw new \\InvalidArgumentException('The URL of the database is not valid');",
        '        }',
        `        $dsn = sprintf(${isMysql(context) ? "'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4'" : "'pgsql:host=%s;port=%d;dbname=%s'"}, $parts['host'], $parts['port'] ?? ${isMysql(context) ? '3306' : '5432'}, ltrim($parts['path'], '/'));`,
        "        return new PDO($dsn, rawurldecode($parts['user'] ?? ''), rawurldecode($parts['pass'] ?? ''), [",
        ...options,
        '        ]);',
      ]
  return phpFile(pathOf(context.base, 'Database'), context.base, 'use PDO;', [
    '/** The database DATABASE_URL names, through PDO. */',
    'final class Database',
    '{',
    `    public const DEFAULT_URL = ${phpString(defaultUrl(context))};`,
    '',
    '    /** The URL of DATABASE_URL, or the default one. */',
    '    public static function url(): string',
    '    {',
    "        $url = getenv('DATABASE_URL');",
    "        return is_string($url) && $url !== '' ? $url : self::DEFAULT_URL;",
    '    }',
    '',
    '    /** A connection to the database at $url (DATABASE_URL when null). */',
    '    public static function open(?string $url = null): PDO',
    '    {',
    '        $url ??= self::url();',
    ...connect,
    '    }',
    '}',
  ])
}

/** Whether a column of the tables has a type of this kind. */
const usesKind = (context: Context, kind: DbType['kind']) =>
  context.tables.some((info) => info.columns.some((column) => column.column.type.kind === kind))

/** A column as a read selects it: an array of PostgreSQL comes as JSON. */
export function selected(context: Context, column: ColumnInfo, name: string): string {
  return context.settings.database === 'postgresql' && column.column.type.kind === 'array' ? `to_json(${name})` : name
}

/** A value read from a row, which may be null, as the property keeps it. */
export function readColumn(context: Context, column: ColumnInfo, value: string): string {
  const type = column.column.type
  const database = context.settings.database
  const present = (code: string) => `${value} === null ? null : ${code}`
  switch (type.kind) {
    case 'integer':
      return present(`(int) ${value}`)
    case 'float':
      return present(`(float) ${value}`)
    case 'boolean':
      return present(`(bool) ${value}`)
    case 'decimal':
      // SQLite keeps a decimal as a number: its scale is given back from the column's
      if (database === 'sqlite' && type.scale !== undefined) return present(`number_format((float) ${value}, ${type.scale}, '.', '')`)
      return present(`(string) ${value}`)
    case 'date':
      return present(`new \\DateTimeImmutable(${value})`)
    case 'datetime':
      // A time without its zone (all of MySQL's, and SQLite's CURRENT_TIMESTAMP) is in UTC
      return present(
        type.timezone && database !== 'postgresql'
          ? `new \\DateTimeImmutable(${value}, new \\DateTimeZone('UTC'))`
          : `new \\DateTimeImmutable(${value})`,
      )
    case 'json':
    case 'array':
      return present(`json_decode(${value}, true, flags: JSON_THROW_ON_ERROR)`)
    case 'binary':
      return database === 'postgresql' ? present(`Sql::bytes(${value})`) : present(`(string) ${value}`)
    default:
      return present(`(string) ${value}`)
  }
}

/** A value of the property as the driver takes it. */
export function writeValue(context: Context, column: ColumnInfo, value: string, optional: boolean): string {
  const type = column.column.type
  const database = context.settings.database
  const arrow = optional ? '?->' : '->'
  const present = (code: string) => (optional ? `${value} === null ? null : ${code}` : code)
  switch (type.kind) {
    case 'date':
      return `${value}${arrow}format('Y-m-d')`
    case 'datetime':
      if (!type.timezone) return `${value}${arrow}format('Y-m-d H:i:s.u')`
      if (database === 'postgresql') return `${value}${arrow}format('Y-m-d H:i:s.uP')`
      return `${value}${arrow}setTimezone(new \\DateTimeZone('UTC'))${arrow}format('Y-m-d H:i:s.u')`
    case 'json':
      return present(`json_encode(${value}, JSON_THROW_ON_ERROR)`)
    case 'array':
      return present(database === 'postgresql' ? `Sql::arrayLiteral(${value})` : `json_encode(${value}, JSON_THROW_ON_ERROR)`)
    case 'binary':
      if (database === 'postgresql') return present(`'\\x' . bin2hex(${value})`)
      return database === 'sqlite' ? present(`Sql::blob(${value})`) : value
    default:
      return value
  }
}

/** `Sql`: what the repositories run their SQL with. */
function sqlFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const postgres = database === 'postgresql'
  const sqlite = database === 'sqlite'
  const blobs = sqlite && usesKind(context, 'binary')
  const body: Line[] = [
    "/** What the repositories run their SQL with, over PDO: statements and their values, and the database's refusals. */",
    'final class Sql',
    '{',
    '    /**',
    '     * Every row of a query, as the list of its columns.',
    '     *',
    '     * @param list<mixed> $values',
    '     * @return list<list<mixed>>',
    '     */',
    '    public static function all(PDO $db, string $sql, array $values = []): array',
    '    {',
    '        return self::run($db, $sql, $values)->fetchAll(PDO::FETCH_NUM);',
    '    }',
    '',
    '    /**',
    '     * The first row of a query, or null.',
    '     *',
    '     * @param list<mixed> $values',
    '     * @return list<mixed>|null',
    '     */',
    '    public static function one(PDO $db, string $sql, array $values = []): ?array',
    '    {',
    '        return self::all($db, $sql, $values)[0] ?? null;',
    '    }',
    '',
    '    /**',
    '     * Runs a statement with its values, in order.',
    '     *',
    '     * @param list<mixed> $values',
    '     */',
    '    public static function run(PDO $db, string $sql, array $values = []): PDOStatement',
    '    {',
    '        $statement = $db->prepare($sql);',
    '        foreach ($values as $index => $value) {',
    '            $statement->bindValue($index + 1, $value, match (true) {',
    '                $value === null => PDO::PARAM_NULL,',
    '                is_int($value) => PDO::PARAM_INT,',
    `                is_bool($value) => PDO::${postgres ? 'PARAM_BOOL' : 'PARAM_INT'},`,
    blobs && '                is_resource($value) => PDO::PARAM_LOB,',
    '                default => PDO::PARAM_STR,',
    '            });',
    '        }',
    '        $statement->execute();',
    '        return $statement;',
    '    }',
    '',
    '    /** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
    '    public static function isRefusal(PDOException $error): bool',
    '    {',
    ...(isMysql(context)
      ? [
          '        // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)',
          "        return str_starts_with((string) $error->getCode(), '23') || in_array($error->errorInfo[1] ?? null, [3819, 4025], true);",
        ]
      : [
          '        // SQLSTATE class 23: integrity constraint violation',
          "        return str_starts_with((string) $error->getCode(), '23');",
        ]),
    '    }',
    ...(postgres && usesKind(context, 'binary')
      ? [
          '',
          '    /** The bytes of a binary column, which PDO gives as a stream. */',
          '    public static function bytes(mixed $value): string',
          '    {',
          '        return is_resource($value) ? (string) stream_get_contents($value) : (string) $value;',
          '    }',
        ]
      : []),
    ...(blobs
      ? [
          '',
          '    /**',
          '     * Bytes as a stream, so SQLite keeps them as a BLOB and not as a text.',
          '     *',
          '     * @return resource',
          '     */',
          '    public static function blob(string $bytes)',
          '    {',
          "        $stream = fopen('php://memory', 'r+b');",
          '        fwrite($stream, $bytes);',
          '        rewind($stream);',
          '        return $stream;',
          '    }',
        ]
      : []),
    ...(postgres && usesKind(context, 'array')
      ? [
          '',
          '    /** A list as an array literal of PostgreSQL. */',
          '    public static function arrayLiteral(array $items): string',
          '    {',
          "        return '{' . implode(',', array_map(fn (mixed $item) => match (true) {",
          "            $item === null => 'NULL',",
          '            is_array($item) => self::arrayLiteral($item),',
          "            is_bool($item) => $item ? 'true' : 'false',",
          "            default => '\"' . addcslashes((string) $item, '\"\\\\') . '\"',",
          "        }, $items)) . '}';",
          '    }',
        ]
      : []),
    '}',
  ]
  return phpFile(
    pathOf(context.base, 'Sql'),
    context.base,
    ['use PDO;', 'use PDOException;', 'use PDOStatement;'].join('\n'),
    body.filter((line): line is string => typeof line === 'string'),
  )
}

/** The entity of a table: a plain class with a property per column, null until it is set or read. */
export function sqlEntityFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const properties = info.columns.flatMap((column, index) => [
    index > 0 ? '' : null,
    column.column.comment ? `    /** ${column.column.comment} */` : null,
    column.column.type.kind === 'unknown' ? `    // TODO: "${column.column.type.sql}" has no PHP type here; it is kept as its text` : null,
    `    public ${optionalType(column)} $${column.prop} = null;`,
  ])
  return phpFile(pathOf(ns, info.entity), ns, '', [
    `/** A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. The repositories read and write it with SQL; a property stays null until it is set or read. */`,
    `class ${info.entity}`,
    '{',
    ...properties,
    '}',
  ])
}

/** The uses of a repository that runs SQL. */
export function sqlUses(context: Context, uses: PhpUses): void {
  uses.add('PDO', className(context.base, 'Sql'))
}

export const sqlDatabaseFiles = (context: Context) => [databaseFile(context), sqlFile(context)]
