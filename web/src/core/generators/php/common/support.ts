/**
 * What every PHP project shares: the domain errors services throw (no HTTP codes), the pages lists are read in,
 * Patch (a field of an update: absent, or a value that may be null), new uuids, and the unit of work over the
 * repositories, with its in-memory version.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Line } from '../../types.ts'
import {
  className,
  commonNamespace,
  errorsNamespace,
  memoryRepositoryClass,
  namespaceOf,
  pathOf,
  phpFile,
  repositoryType,
  type Context,
  type TableInfo,
} from './context.ts'
import { PhpUses } from './php.ts'

const file = (ns: string, name: string, body: Line[], uses = '') =>
  phpFile(
    pathOf(ns, name),
    ns,
    uses,
    body.filter((line): line is string => typeof line === 'string'),
  )

export function errorFiles(context: Context): GeneratedFile[] {
  const ns = errorsNamespace(context)
  return [
    file(ns, 'DomainException', [
      '/** Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them. */',
      'abstract class DomainException extends \\RuntimeException',
      '{',
      '}',
    ]),
    file(ns, 'NotFoundException', [
      '/** No row has this key. */',
      'final class NotFoundException extends DomainException',
      '{',
      '    public function __construct(public readonly string $entity, public readonly mixed $key)',
      '    {',
      "        $text = fn (mixed $value) => $value instanceof \\DateTimeInterface ? $value->format('Y-m-d H:i:s') : strval($value);",
      '        parent::__construct("No {$entity} has the key " . implode(\', \', array_map($text, is_array($key) ? $key : [$key])));',
      '    }',
      '}',
    ]),
    file(ns, 'ConflictException', [
      '/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */',
      'final class ConflictException extends DomainException',
      '{',
      '    /** @param list<string> $fields */',
      '    public function __construct(public readonly string $entity, public readonly string $reason, public readonly array $fields = [])',
      '    {',
      '        parent::__construct("{$entity}: {$reason}");',
      '    }',
      '}',
    ]),
    file(ns, 'FieldError', [
      '/** What is wrong with one field. */',
      'final readonly class FieldError',
      '{',
      '    public function __construct(public string $field, public string $message)',
      '    {',
      '    }',
      '}',
    ]),
    file(ns, 'ValidationFailedException', [
      '/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */',
      'final class ValidationFailedException extends DomainException',
      '{',
      '    /** @param list<FieldError> $errors */',
      '    public function __construct(public readonly string $entity, public readonly array $errors)',
      '    {',
      "        parent::__construct($entity . ': ' . implode('; ', array_map(fn (FieldError $error) => \"{$error->field}: {$error->message}\", $errors)));",
      '    }',
      '}',
    ]),
  ]
}

/** Whether a repository makes uuids before an insert: a column the database fills with one. */
export const makesUuids = (context: Context) =>
  context.tables.some((info) => info.columns.some((column) => column.column.generated === 'uuid'))

export function commonFiles(context: Context): GeneratedFile[] {
  const ns = commonNamespace(context)
  const files: GeneratedFile[] = []
  if (context.settings.paging === 'offset')
    files.push(
      file(ns, 'Page', [
        '/**',
        ' * A page of a list: the rows from an offset, and how many there are in all.',
        ' *',
        ' * @template T',
        ' */',
        'final readonly class Page',
        '{',
        '    /** @param list<T> $items */',
        '    public function __construct(public array $items, public int $total, public int $offset, public int $limit)',
        '    {',
        '    }',
        '',
        '    /**',
        '     * The same page with every row turned into something else.',
        '     *',
        '     * @template R',
        '     * @param callable(T): R $mapper',
        '     * @return Page<R>',
        '     */',
        '    public function map(callable $mapper): self',
        '    {',
        '        return new self(array_map($mapper, $this->items), $this->total, $this->offset, $this->limit);',
        '    }',
        '}',
      ]),
    )
  if (context.settings.paging === 'cursor')
    files.push(
      file(ns, 'CursorPage', [
        '/**',
        ' * A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page).',
        ' *',
        ' * @template T',
        ' */',
        'final readonly class CursorPage',
        '{',
        '    /**',
        '     * @param list<T> $items',
        '     * @param list<mixed>|null $next',
        '     */',
        '    public function __construct(public array $items, public ?array $next)',
        '    {',
        '    }',
        '',
        '    /**',
        '     * The same page with every row turned into something else.',
        '     *',
        '     * @template R',
        '     * @param callable(T): R $mapper',
        '     * @return CursorPage<R>',
        '     */',
        '    public function map(callable $mapper): self',
        '    {',
        '        return new self(array_map($mapper, $this->items), $this->next);',
        '    }',
        '}',
      ]),
    )
  if (context.settings.services && context.settings.updates === 'patch')
    files.push(
      file(ns, 'Patch', [
        '/**',
        ' * A field of an update: absent (it keeps its value), or present with a value, which may be null.',
        ' *',
        ' * @template T',
        ' */',
        'final readonly class Patch',
        '{',
        '    /** An absent field; use Patch::of() for one with a value. */',
        '    public function __construct(public bool $isPresent = false, public mixed $value = null)',
        '    {',
        '    }',
        '',
        '    /**',
        '     * The field keeps its value.',
        '     *',
        '     * @return Patch<mixed>',
        '     */',
        '    public static function absent(): self',
        '    {',
        '        return new self();',
        '    }',
        '',
        '    /**',
        '     * The field takes this value, which may be null.',
        '     *',
        '     * @template V',
        '     * @param V $value',
        '     * @return Patch<V>',
        '     */',
        '    public static function of(mixed $value): self',
        '    {',
        '        return new self(true, $value);',
        '    }',
        '}',
      ]),
    )
  if (makesUuids(context))
    files.push(
      file(ns, 'Uuid', [
        '/** New uuids, for the columns the database fills with one: not every database can, so they are made before the insert. */',
        'final class Uuid',
        '{',
        '    /** A random uuid (version 4). */',
        '    public static function v4(): string',
        '    {',
        '        $bytes = random_bytes(16);',
        '        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);',
        '        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);',
        "        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));",
        '    }',
        '}',
      ]),
    )
  return files
}

const HOW = {
  operation: 'Each service operation runs in transaction(): committed when it ends, rolled back when it fails.',
  caller: 'Services never commit: whoever holds the connection opens and ends its transaction; transaction() only groups the code.',
  repository: 'Every repository write is committed at once; transaction() only groups the code.',
}

/** The repositories a unit of work holds, with their uses. */
export function repositoryProperties(context: Context, uses: PhpUses, value?: (info: TableInfo) => string): Line[] {
  return context.tables.map((info) => {
    uses.add(className(namespaceOf(context, info, 'repository'), repositoryType(context, info)))
    return value
      ? `public readonly ${repositoryType(context, info)} $${info.attr};`
      : `public ${repositoryType(context, info)} $${info.attr} { get; }`
  })
}

/** The assignments of a unit of work's constructor. */
export const repositoryAssignments = (context: Context, value: (info: TableInfo) => string): Line[] =>
  context.tables.map((info) => `$this->${info.attr} = ${value(info)};`)

const ind = (items: Line[], spaces = 4): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

/** UnitOfWork, SqlUnitOfWork (written by the ORM) and MemoryUnitOfWork, in the root namespace. */
export function unitOfWorkFiles(context: Context): GeneratedFile[] {
  const ns = context.base
  const settings = context.settings
  const interfaceUses = new PhpUses(ns)
  const files: GeneratedFile[] = [
    file(
      ns,
      'UnitOfWork',
      [
        `/** What services depend on: a repository per table and a transaction. ${HOW[settings.transactions]} */`,
        'interface UnitOfWork',
        '{',
        ...ind(repositoryProperties(context, interfaceUses)),
        '',
        '    /**',
        '     * Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws.',
        '     *',
        '     * @template T',
        '     * @param callable(UnitOfWork): T $work',
        '     * @return T',
        '     */',
        '    public function transaction(callable $work): mixed;',
        '}',
      ],
      interfaceUses.write(),
    ),
  ]
  const sqlUses = new PhpUses(ns)
  const sql = context.orm.unitOfWork(context, sqlUses)
  files.push(file(ns, 'SqlUnitOfWork', sql, sqlUses.write()))
  if (settings.memoryRepositories) {
    const uses = new PhpUses(ns)
    const properties = repositoryProperties(context, uses, (info) => info.attr)
    for (const info of context.tables) uses.add(className(namespaceOf(context, info, 'repository'), memoryRepositoryClass(info)))
    files.push(
      file(
        ns,
        'MemoryUnitOfWork',
        [
          '/** The in-memory repositories, for tests and for trying the services without a database. */',
          'final class MemoryUnitOfWork implements UnitOfWork',
          '{',
          ...ind(properties),
          '',
          '    public function __construct()',
          '    {',
          ...ind(
            repositoryAssignments(context, (info) => `new ${memoryRepositoryClass(info)}()`),
            8,
          ),
          '    }',
          '',
          '    /** Memory has no transactions: changes are kept as they are made. */',
          '    public function transaction(callable $work): mixed',
          '    {',
          '        return $work($this);',
          '    }',
          '}',
        ],
        uses.write(),
      ),
    )
  }
  return files
}
