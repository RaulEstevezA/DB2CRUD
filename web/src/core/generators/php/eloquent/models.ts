/**
 * The model of each table for Eloquent 12 (without Laravel): the table, its key, the casts that give each column its
 * PHP type, the defaults the database would set, and a @property per column so editors know them. Eloquent keys a
 * model by one column: for a key of several columns, or none, the repositories read and write by every column of
 * it, and the model says so.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbType } from '../../../schema/types.ts'
import { namespaceOf, pathOf, phpFile, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { phpString } from '../common/php.ts'
import { defaultLiteral } from '../common/repositories.ts'

/** The PHP type of a value as Eloquent gives it, with the casts of the model. */
export function eloquentPhpType(type: DbType): string {
  switch (type.kind) {
    case 'integer':
      return 'int'
    case 'float':
      return 'float'
    case 'boolean':
      return 'bool'
    // CarbonImmutable, which is a DateTimeImmutable
    case 'date':
    case 'datetime':
      return '\\DateTimeImmutable'
    case 'json':
    case 'array':
      return 'mixed'
    // A time of day has no cast of its own: its text
    case 'time':
    case 'decimal':
    case 'uuid':
    case 'binary':
    case 'text':
    case 'enum':
    case 'unknown':
      return 'string'
  }
}

/** The cast of a column, when its value needs one. */
function cast(context: Context, column: ColumnInfo): string | null {
  const type = column.column.type
  switch (type.kind) {
    case 'integer':
      return 'integer'
    case 'float':
      return 'float'
    case 'boolean':
      return 'boolean'
    case 'decimal':
      return type.scale !== undefined ? `decimal:${type.scale}` : null
    case 'date':
      return 'immutable_date'
    case 'datetime':
      return 'immutable_datetime'
    case 'array':
      return context.settings.database === 'postgresql' ? `\\${context.base}\\PgArray::class${arrayItem(type)}` : 'json'
    case 'json':
      return 'json'
    default:
      return null
  }
}

/** The argument of the cast of an array: the PHP type of its items, when it is not text. */
function arrayItem(type: DbType): string {
  const item = type.kind === 'array' ? type.items : type
  if (item.kind === 'array') return arrayItem(item)
  const php = item.kind === 'integer' ? 'int' : item.kind === 'float' ? 'float' : item.kind === 'boolean' ? 'bool' : null
  return php ? ` . ':${php}'` : ''
}

/** `PgArray.php`, when a model has an array of PostgreSQL: its cast. */
export function pgArrayFile(context: Context): GeneratedFile | null {
  if (context.settings.database !== 'postgresql') return null
  if (!context.tables.some((info) => info.writesEntity && info.columns.some((column) => column.column.type.kind === 'array'))) return null
  return phpFile(pathOf(context.base, 'PgArray'), context.base, 'use Illuminate\\Contracts\\Database\\Eloquent\\CastsAttributes;', [
    '/**',
    ' * An array of PostgreSQL ({a,b}) as a PHP array; its items are text, or of the type the cast names.',
    ' *',
    ' * @implements CastsAttributes<array<int, mixed>, array<int, mixed>>',
    ' */',
    'final class PgArray implements CastsAttributes',
    '{',
    "    public function __construct(private readonly string $item = 'string')",
    '    {',
    '    }',
    '',
    '    public function get($model, string $key, mixed $value, array $attributes): ?array',
    '    {',
    '        if ($value === null) {',
    '            return null;',
    '        }',
    '        $at = 0;',
    '        return $this->read((string) $value, $at);',
    '    }',
    '',
    '    public function set($model, string $key, mixed $value, array $attributes): ?string',
    '    {',
    '        return is_array($value) ? $this->write($value) : $value;',
    '    }',
    '',
    '    /** The array that starts at a position of the text, which is left after it. */',
    '    private function read(string $text, int &$at): array',
    '    {',
    '        $items = [];',
    '        $at++;',
    "        while ($text[$at] !== '}') {",
    "            if ($text[$at] === ',') {",
    '                $at++;',
    "            } elseif ($text[$at] === '{') {",
    '                $items[] = $this->read($text, $at);',
    "            } elseif ($text[$at] === '\"') {",
    "                $item = '';",
    "                for ($at++; $text[$at] !== '\"'; $at++) {",
    "                    if ($text[$at] === '\\\\') {",
    '                        $at++;',
    '                    }',
    '                    $item .= $text[$at];',
    '                }',
    '                $at++;',
    '                $items[] = $this->item($item);',
    '            } else {',
    "                $length = strcspn($text, ',}', $at);",
    '                $item = substr($text, $at, $length);',
    '                $at += $length;',
    "                $items[] = $item === 'NULL' ? null : $this->item($item);",
    '            }',
    '        }',
    '        $at++;',
    '        return $items;',
    '    }',
    '',
    '    private function item(string $text): int|float|bool|string',
    '    {',
    '        return match ($this->item) {',
    "            'int' => (int) $text,",
    "            'float' => (float) $text,",
    "            'bool' => $text === 't',",
    '            default => $text,',
    '        };',
    '    }',
    '',
    '    private function write(array $items): string',
    '    {',
    '        $written = array_map(fn (mixed $item): string => match (true) {',
    "            $item === null => 'NULL',",
    '            is_array($item) => $this->write($item),',
    "            is_bool($item) => $item ? 't' : 'f',",
    "            default => '\"' . addcslashes((string) $item, '\"\\\\') . '\"',",
    '        }, $items);',
    "        return '{' . implode(',', $written) . '}';",
    '    }',
    '}',
  ])
}

/** Whether Eloquent can key the model by its primary key: one column. */
export const singleKey = (info: TableInfo) => info.table.primaryKey !== null && info.table.primaryKey.length === 1

export function eloquentModelFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const { table } = info
  const key = singleKey(info) ? info.key[0] : null
  const casts = info.columns
    .map((column) => [column, cast(context, column)] as const)
    .filter((item): item is [ColumnInfo, string] => item[1] !== null)
  const defaults = info.columns.filter(
    (column) => column.column.default?.kind === 'literal' && column.column.default.value !== null && column.php !== '\\DateTimeImmutable',
  )
  const notes = [
    ...table.foreignKeys.map(
      (item) =>
        ` * Foreign key: ${item.columns.join(', ')} → ${item.references.table}(${item.references.columns.join(', ')})${item.onDelete ? `, on delete ${item.onDelete}` : ''}.`,
    ),
    ...table.checks.map((check) => ` * CHECK (${check.sql}): the service checks what it understands of it.`),
    ...(key
      ? []
      : [
          table.primaryKey
            ? ` * Its key has several columns (${table.primaryKey.join(', ')}): Eloquent keys a model by one, so the repository reads and writes it by all of them.`
            : ' * The table has no primary key: the repository tells its rows apart by all their columns.',
        ]),
  ]
  const body = [
    '/**',
    ` * A row of the "${table.name}" table${table.comment ? `: ${table.comment}` : ''}.`,
    ...(notes.length > 0 ? [' *', ...notes] : []),
    ' *',
    // Any attribute may be unset until the row is stored
    ...info.columns.map((column) => ` * @property ${column.php}${column.php === 'mixed' ? '' : '|null'} $${column.prop}`),
    ' */',
    `class ${info.entity} extends Model`,
    '{',
    `    protected $table = ${phpString(table.schema ? `${table.schema}.${table.name}` : table.name)};`,
    '',
    key ? `    protected $primaryKey = ${phpString(key.column.name)};` : '    protected $primaryKey = null;',
    '',
    `    public $incrementing = ${key?.column.generated === 'identity' ? 'true' : 'false'};`,
    ...(key && key.php === 'string' ? ['', "    protected $keyType = 'string';"] : []),
    '',
    "    /** The table has no created_at and updated_at of Eloquent's own */",
    '    public $timestamps = false;',
    '',
    '    /** How dates are written to the database */',
    "    protected $dateFormat = 'Y-m-d H:i:s';",
    ...(defaults.length > 0
      ? [
          '',
          '    /** The values the database sets when a row leaves them out */',
          '    protected $attributes = [',
          ...defaults.map((column) => {
            const value = column.column.default!.kind === 'literal' ? column.column.default!.value : null
            return `        ${phpString(column.column.name)} => ${defaultLiteral(column, value)},`
          }),
          '    ];',
        ]
      : []),
    ...(casts.length > 0
      ? [
          '',
          '    /** @var array<string, string> */',
          '    protected $casts = [',
          ...casts.map(
            ([column, item]) => `        ${phpString(column.column.name)} => ${item.includes('::class') ? item : phpString(item)},`,
          ),
          '    ];',
        ]
      : []),
    ...(info.columns.some((column) => column.column.type.kind === 'unknown')
      ? [
          '',
          `    // TODO: ${info.columns
            .filter((column) => column.column.type.kind === 'unknown')
            .map((column) => `"${column.column.type.sql}"`)
            .join(', ')} has no cast here; kept as text`,
        ]
      : []),
    '}',
  ]
  return phpFile(pathOf(ns, info.entity), ns, 'use Illuminate\\Database\\Eloquent\\Model;', body)
}
