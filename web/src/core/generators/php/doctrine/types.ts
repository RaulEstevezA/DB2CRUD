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

export const typesNamespace = (context: Context) => `${context.base}\\Types`

/** Whether an entity the project writes has a timestamp. */
export const usesPreciseTypes = (context: Context) =>
  context.tables.some((info) => info.writesEntity && info.columns.some((column) => column.column.type.kind === 'datetime'))

/** The classes and DBAL names of the types, for Database.php. */
export const PRECISE_TYPES = [
  { name: 'PreciseDateTimeType', id: PRECISE },
  { name: 'PreciseDateTimeTzType', id: PRECISE_TZ },
]

export function typeFiles(context: Context): GeneratedFile[] {
  if (!usesPreciseTypes(context)) return []
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
    type('PreciseDateTimeType', 'DateTimeImmutableType', PRECISE, 'A timestamp without a time zone', 'Y-m-d H:i:s.u'),
    type('PreciseDateTimeTzType', 'DateTimeTzImmutableType', PRECISE_TZ, 'A timestamp with a time zone', tzFormat),
  ]
}
