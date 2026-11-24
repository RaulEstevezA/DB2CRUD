/**
 * The DBAL types a Doctrine project adds for its timestamps. DBAL 4 reads a timestamp only in the exact format of the
 * platform, without fractions of a second, while a database that already exists usually keeps them (PostgreSQL's
 * timestamps have microseconds by default): these types read any precision and write microseconds. Database.php
 * registers them; the entities name them.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { pathOf, phpFile, type Context } from '../common/context.ts'

export const PRECISE = 'precise_datetime'
export const PRECISE_TZ = 'precise_datetimetz'
export const PRECISE_TIME_TZ = 'precise_timetz'
export const PG_ARRAY = 'pg_array'

export const typesNamespace = (context: Context) => `${context.base}\\Types`

/** Whether an entity the project writes has a timestamp. */
export const usesPreciseTypes = (context: Context) =>
  context.tables.some((info) => info.writesEntity && info.columns.some((column) => column.column.type.kind === 'datetime'))

/** The classes and DBAL names of the types, for Database.php. */
export const PRECISE_TYPES = [
  { name: 'PreciseDateTimeType', id: PRECISE },
  { name: 'PreciseDateTimeTzType', id: PRECISE_TZ },
]

/** Whether an entity the project writes has an array of PostgreSQL. */
export const usesPgArray = (context: Context) =>
  context.settings.database === 'postgresql' &&
  context.tables.some((info) => info.writesEntity && info.columns.some((column) => column.column.type.kind === 'array'))

/** Whether an entity the project writes has a time with a time zone of PostgreSQL. */
export const usesTimeTz = (context: Context) =>
  context.settings.database === 'postgresql' &&
  context.tables.some((info) => info.writesEntity && info.columns.some(({ column }) => column.type.kind === 'time' && column.type.timezone))

/** The DBAL type of a time with a time zone, which DBAL's own cannot read. */
function timeTzFile(context: Context): GeneratedFile {
  const ns = typesNamespace(context)
  return phpFile(
    pathOf(ns, 'PreciseTimeTzType'),
    ns,
    ['use Doctrine\\DBAL\\Platforms\\AbstractPlatform;', 'use Doctrine\\DBAL\\Types\\TimeImmutableType;'].join('\n'),
    [
      '/** A time with a time zone, read and written with its offset. */',
      'final class PreciseTimeTzType extends TimeImmutableType',
      '{',
      `    public const NAME = '${PRECISE_TIME_TZ}';`,
      '',
      '    public function convertToPHPValue(mixed $value, AbstractPlatform $platform): ?\\DateTimeImmutable',
      '    {',
      '        if ($value === null || $value instanceof \\DateTimeImmutable) {',
      '            return $value;',
      '        }',
      '        return new \\DateTimeImmutable((string) $value);',
      '    }',
      '',
      '    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string',
      '    {',
      "        return $value instanceof \\DateTimeInterface ? $value->format('H:i:s.uP') : parent::convertToDatabaseValue($value, $platform);",
      '    }',
      '}',
    ],
  )
}

/** The DBAL type of an array of PostgreSQL: read as JSON, written as its text. */
function pgArrayFile(context: Context): GeneratedFile {
  const ns = typesNamespace(context)
  return phpFile(
    pathOf(ns, 'PgArrayType'),
    ns,
    ['use Doctrine\\DBAL\\Platforms\\AbstractPlatform;', 'use Doctrine\\DBAL\\Types\\JsonType;'].join('\n'),
    [
      '/** An array of PostgreSQL as a PHP array: the database gives it as JSON, and takes it as its text ({a,b}). */',
      'final class PgArrayType extends JsonType',
      '{',
      `    public const NAME = '${PG_ARRAY}';`,
      '',
      '    public function convertToPHPValueSQL(string $sqlExpr, AbstractPlatform $platform): string',
      '    {',
      "        return 'to_json(' . $sqlExpr . ')';",
      '    }',
      '',
      '    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string',
      '    {',
      '        return is_array($value) ? self::write($value) : $value;',
      '    }',
      '',
      '    private static function write(array $items): string',
      '    {',
      '        $written = array_map(fn (mixed $item): string => match (true) {',
      "            $item === null => 'NULL',",
      '            is_array($item) => self::write($item),',
      "            is_bool($item) => $item ? 't' : 'f',",
      "            default => '\"' . addcslashes((string) $item, '\"\\\\') . '\"',",
      '        }, $items);',
      "        return '{' . implode(',', $written) . '}';",
      '    }',
      '}',
    ],
  )
}

export function typeFiles(context: Context): GeneratedFile[] {
  const arrays = [...(usesPgArray(context) ? [pgArrayFile(context)] : []), ...(usesTimeTz(context) ? [timeTzFile(context)] : [])]
  if (!usesPreciseTypes(context)) return arrays
  const ns = typesNamespace(context)
  // Only PostgreSQL keeps the offset: MySQL and MariaDB refuse it in a datetime, and SQLite keeps text
  const tzFormat = context.settings.database === 'postgresql' ? 'Y-m-d H:i:s.uP' : 'Y-m-d H:i:s.u'
  const type = (name: string, parent: string, id: string, doc: string, format: string) =>
    phpFile(
      pathOf(ns, name),
      ns,
      ['use Doctrine\\DBAL\\Platforms\\AbstractPlatform;', `use Doctrine\\DBAL\\Types\\${parent};`].join('\n'),
      [
        `/** ${doc}, read whatever its fractions of a second and written with microseconds. */`,
        `final class ${name} extends ${parent}`,
        '{',
        `    public const NAME = '${id}';`,
        '',
        '    public function convertToPHPValue(mixed $value, AbstractPlatform $platform): ?\\DateTimeImmutable',
        '    {',
        '        if ($value === null || $value instanceof \\DateTimeImmutable) {',
        '            return $value;',
        '        }',
        '        return new \\DateTimeImmutable((string) $value);',
        '    }',
        '',
        '    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string',
        '    {',
        '        if ($value instanceof \\DateTimeInterface) {',
        `            return $value->format('${format}');`,
        '        }',
        '        return parent::convertToDatabaseValue($value, $platform);',
        '    }',
        '}',
      ],
    )
  return [
    ...arrays,
    type('PreciseDateTimeType', 'DateTimeImmutableType', PRECISE, 'A timestamp without a time zone', 'Y-m-d H:i:s.u'),
    type('PreciseDateTimeTzType', 'DateTimeTzImmutableType', PRECISE_TZ, 'A timestamp with a time zone', tzFormat),
  ]
}
