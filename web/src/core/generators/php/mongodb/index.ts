/**
 * PHP + the official MongoDB library (Strategy of common/orm.ts): plain entities whose nested documents are arrays,
 * repositories over Db (the database and the session of its transaction), and tests on a database made empty for each
 * one. `Documents` turns values into what MongoDB stores and back, and checks the documents inside others.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbType } from '../../../schema/types.ts'
import type { Line } from '../../types.ts'
import {
  className,
  errorClass,
  namespaceOf,
  optionalType,
  pathOf,
  phpFile,
  sqlRepositoryClass,
  type Context,
  type TableInfo,
} from '../common/context.ts'
import { docTypeOf } from '../common/documents.ts'
import type { PhpOrm } from '../common/orm.ts'
import { fieldName, phpString, PhpUses } from '../common/php.ts'
import { repositoryAssignments, repositoryProperties } from '../common/support.ts'
import { testFile, TESTS_NS } from '../common/tests.ts'
import { body, helpers, init } from './repository.ts'

const URL = 'mongodb://localhost:27017/app'

/** The PHP type of a value as the entities keep it. */
function phpType(type: DbType): string {
  switch (type.kind) {
    case 'integer':
      return 'int'
    case 'float':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'datetime':
      return '\\DateTimeImmutable'
    case 'array':
      return 'array'
    case 'json':
      return type.fields ? 'array' : 'mixed'
    case 'unknown':
      return 'mixed'
    default:
      return 'string'
  }
}

function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const properties = info.columns.flatMap((column, index) => {
    const type = column.column.type
    const doc = type.kind === 'array' || (type.kind === 'json' && type.fields) ? `@var ${docTypeOf(context, type)}|null` : null
    const comment = [column.column.comment, doc].filter((item): item is string => Boolean(item)).join(' ')
    return [
      index > 0 ? '' : null,
      comment ? `    /** ${comment.replace(/\*\//g, '* /').replace(/\s+/g, ' ')} */` : null,
      `    public ${optionalType(column)} $${column.prop} = null;`,
    ]
  })
  return phpFile(pathOf(ns, info.entity), ns, '', [
    `/** A document of the "${info.name}" collection; those inside it are arrays, by the stored names of their fields. A property stays null until it is set or read. */`,
    `class ${info.entity}`,
    '{',
    ...properties,
    '}',
  ])
}

const file = (context: Context, name: string, uses: PhpUses, lines: Line[]) =>
  phpFile(
    pathOf(context.base, name),
    context.base,
    uses.write(),
    lines.filter((line): line is string => typeof line === 'string'),
  )

function databaseFile(context: Context): GeneratedFile {
  return file(context, 'Database', new PhpUses(context.base).add('MongoDB\\Client'), [
    '/** The MongoDB database DATABASE_URL names. It creates no collection and no index: the database already exists. */',
    'final class Database',
    '{',
    `    public const DEFAULT_URL = ${phpString(URL)};`,
    '',
    '    /** The URL of DATABASE_URL, or the default one. */',
    '    public static function url(): string',
    '    {',
    "        $url = getenv('DATABASE_URL');",
    "        return is_string($url) && $url !== '' ? $url : self::DEFAULT_URL;",
    '    }',
    '',
    '    /** The name of the database a URL names. */',
    '    public static function name(string $url): string',
    '    {',
    "        if (preg_match('#^mongodb(?:\\+srv)?://[^/]+/([^?]+)#', $url, $found) !== 1) {",
    "            throw new \\InvalidArgumentException('The URL names no database');",
    '        }',
    '        return rawurldecode($found[1]);',
    '    }',
    '',
    '    /** A Db over the database at $url (DATABASE_URL when null), one per unit of work; the driver keeps the connections. */',
    '    public static function open(?string $url = null): Db',
    '    {',
    '        $url ??= self::url();',
    '        return new Db((new Client($url))->selectDatabase(self::name($url)));',
    '    }',
    '}',
  ])
}

function dbFile(context: Context): GeneratedFile {
  const uses = new PhpUses(context.base).add(
    'MongoDB\\Collection',
    'MongoDB\\Driver\\Exception\\BulkWriteException',
    'MongoDB\\Driver\\Exception\\CommandException',
    'MongoDB\\Driver\\Exception\\InvalidArgumentException',
    'MongoDB\\Driver\\Session',
    'MongoDB\\Operation\\FindOneAndUpdate',
    errorClass(context, 'ConflictException'),
    errorClass(context, 'FieldError'),
    errorClass(context, 'ValidationFailedException'),
  )
  return file(context, 'Db', uses, [
    '/** A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused write is a ConflictException. */',
    'final class Db',
    '{',
    '    private ?Session $session = null;',
    '',
    '    public function __construct(public readonly \\MongoDB\\Database $database)',
    '    {',
    '    }',
    '',
    '    public function inTransaction(): bool',
    '    {',
    '        return $this->session !== null;',
    '    }',
    '',
    '    public function begin(): void',
    '    {',
    '        $this->session = $this->database->getManager()->startSession();',
    '        $this->session->startTransaction();',
    '    }',
    '',
    '    public function commit(): void',
    '    {',
    '        $this->session?->commitTransaction();',
    '        $this->session = null;',
    '    }',
    '',
    '    public function rollBack(): void',
    '    {',
    '        if ($this->session?->isInTransaction()) {',
    '            $this->session->abortTransaction();',
    '        }',
    '        $this->session = null;',
    '    }',
    '',
    '    public function collection(string $name): Collection',
    '    {',
    "        return $this->database->selectCollection($name, ['typeMap' => ['root' => 'array', 'document' => 'array', 'array' => 'array']]);",
    '    }',
    '',
    '    /**',
    '     * The documents of a collection.',
    '     *',
    '     * @param array<string, mixed> $filter',
    '     * @param array<string, mixed> $options',
    '     * @return list<array<string, mixed>>',
    '     */',
    '    public function find(string $collection, array $filter, array $options = []): array',
    '    {',
    '        return $this->collection($collection)->find($filter, $this->options($options))->toArray();',
    '    }',
    '',
    '    /** @param array<string, mixed> $filter */',
    '    public function count(string $collection, array $filter): int',
    '    {',
    '        return $this->collection($collection)->countDocuments($filter, $this->options());',
    '    }',
    '',
    '    /** @param callable(): array<string, mixed> $document */',
    '    public function insert(string $entity, string $collection, callable $document): void',
    '    {',
    '        $this->write($entity, fn () => $this->collection($collection)->insertOne($document(), $this->options()));',
    '    }',
    '',
    '    /**',
    '     * Changes one document; inside write().',
    '     *',
    '     * @param array<string, mixed> $filter',
    '     * @param array<string, mixed> $change',
    '     */',
    '    public function update(string $collection, array $filter, array $change): void',
    '    {',
    '        $this->collection($collection)->updateOne($filter, $change, $this->options());',
    '    }',
    '',
    '    /** @param array<string, mixed> $filter */',
    '    public function delete(string $entity, string $collection, array $filter): void',
    '    {',
    '        $this->write($entity, fn () => $this->collection($collection)->deleteOne($filter, $this->options()));',
    '    }',
    '',
    '    /**',
    '     * Changes one document where it is, and gives it as it is then; null when there is none.',
    '     *',
    '     * @param callable(): array{array<string, mixed>, array<mixed>} $change its filter and its change',
    '     * @return array<string, mixed>|null',
    '     */',
    '    public function change(string $entity, string $collection, callable $change): ?array',
    '    {',
    '        return $this->write($entity, fn () => $this->collection($collection)->findOneAndUpdate(',
    "            ...[...$change(), $this->options(['returnDocument' => FindOneAndUpdate::RETURN_DOCUMENT_AFTER])],",
    '        ));',
    '    }',
    '',
    '    /** Runs a write: a repeated value, or one the validator of the collection does not take, is a ConflictException; a text that is no identifier or number, a ValidationFailedException. */',
    '    public function write(string $entity, callable $work): mixed',
    '    {',
    '        try {',
    '            return $work();',
    '        } catch (BulkWriteException|CommandException $error) {',
    '            $codes = [$error->getCode()];',
    '            if ($error instanceof BulkWriteException) {',
    '                foreach ($error->getWriteResult()->getWriteErrors() as $refusal) {',
    '                    $codes[] = $refusal->getCode();',
    '                }',
    '            }',
    '            if (array_intersect($codes, [11000, 121]) === []) {',
    '                throw $error;',
    '            }',
    "            throw new ConflictException($entity, 'the database refused the change: ' . $error->getMessage());",
    '        } catch (InvalidArgumentException $error) {',
    "            throw new ValidationFailedException($entity, [new FieldError('', $error->getMessage())]);",
    '        }',
    '    }',
    '',
    '    /**',
    '     * @param array<string, mixed> $options',
    '     * @return array<string, mixed>',
    '     */',
    '    private function options(array $options = []): array',
    '    {',
    "        return $this->session === null ? $options : [...$options, 'session' => $this->session];",
    '    }',
    '}',
  ])
}

function documentsFile(context: Context): GeneratedFile {
  const uses = new PhpUses(context.base).add(
    'MongoDB\\BSON\\Binary',
    'MongoDB\\BSON\\Decimal128',
    'MongoDB\\BSON\\Document',
    'MongoDB\\BSON\\Int64',
    'MongoDB\\BSON\\ObjectId',
    'MongoDB\\BSON\\UTCDateTime',
    errorClass(context, 'FieldError'),
  )
  return file(context, 'Documents', uses, [
    '/** Values as MongoDB stores them and as PHP has them, what changed in a document, and the rules of the documents inside others. */',
    'final class Documents',
    '{',
    '    /** Whether a text is an identifier (an ObjectId). */',
    '    public static function isId(mixed $value): bool',
    '    {',
    "        return is_string($value) && preg_match('/^[0-9a-f]{24}$/iD', $value) === 1;",
    '    }',
    '',
    '    /** A value as MongoDB stores it, by its shape: a kind, the `items` of a list or the `fields` of a document. What no shape names stays as it is. */',
    '    public static function toBson(mixed $value, string|array|null $shape): mixed',
    '    {',
    '        if ($value === null || $shape === null) {',
    '            return $value;',
    '        }',
    '        if (is_array($shape)) {',
    '            if (!is_array($value)) {',
    '                return $value;',
    '            }',
    "            if (isset($shape['items'])) {",
    "                return array_map(fn (mixed $item) => self::toBson($item, $shape['items']), array_values($value));",
    '            }',
    '            $document = [];',
    '            foreach ($value as $name => $item) {',
    "                $known = array_key_exists($name, $shape['fields']);",
    '                // A field without a value is left out',
    '                if (!$known || $item !== null) {',
    "                    $document[$name] = $known ? self::toBson($item, $shape['fields'][$name]) : $item;",
    '                }',
    '            }',
    '            // An empty array would be a list',
    '            return $document === [] ? new \\stdClass() : $document;',
    '        }',
    '        return match ($shape) {',
    "            'objectId' => $value instanceof ObjectId ? $value : new ObjectId((string) $value),",
    "            'decimal' => $value instanceof Decimal128 ? $value : new Decimal128((string) $value),",
    "            'uuid' => $value instanceof Binary ? $value : new Binary((string) hex2bin(str_replace('-', '', $value)), Binary::TYPE_UUID),",
    "            'binary' => $value instanceof Binary ? $value : new Binary($value, Binary::TYPE_GENERIC),",
    "            'datetime' => $value instanceof \\DateTimeInterface ? new UTCDateTime($value) : $value,",
    "            'long' => is_int($value) ? new Int64($value) : $value,",
    "            'double' => is_int($value) ? (float) $value : $value,",
    '            default => $value,',
    '        };',
    '    }',
    '',
    '    /** A value of MongoDB as PHP has it, by its shape. */',
    '    public static function fromBson(mixed $value, string|array|null $shape): mixed',
    '    {',
    '        if (is_array($shape) && is_array($value)) {',
    "            if (isset($shape['items'])) {",
    "                return array_map(fn (mixed $item) => self::fromBson($item, $shape['items']), array_values($value));",
    '            }',
    '            foreach ($value as $name => $item) {',
    "                $value[$name] = self::fromBson($item, $shape['fields'][$name] ?? null);",
    '            }',
    '            return $value;',
    '        }',
    '        if ($value === null || $shape === null) {',
    '            return $value;',
    '        }',
    '        return match (true) {',
    '            $value instanceof ObjectId, $value instanceof Decimal128 => (string) $value,',
    '            $value instanceof UTCDateTime => \\DateTimeImmutable::createFromInterface($value->toDateTime()),',
    "            $value instanceof Binary => $shape === 'uuid' ? vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($value->getData()), 4)) : $value->getData(),",
    '            $value instanceof Int64 => (int) (string) $value,',
    "            $shape === 'double' && is_int($value) => (float) $value,",
    "            $shape === 'int' && is_float($value), $shape === 'long' && is_float($value) => (int) $value,",
    "            $shape === 'decimal' => (string) $value,",
    '            default => $value,',
    '        };',
    '    }',
    '',
    '    /**',
    '     * The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own.',
    '     *',
    '     * @param array<string, mixed> $before',
    '     * @param array<string, mixed> $now',
    '     * @param list<string> $fields',
    '     * @return array<string, array<string, mixed>>',
    '     */',
    '    public static function changes(array $before, array $now, array $fields): array',
    '    {',
    "        $changes = ['$set' => [], '$unset' => []];",
    '        foreach ($fields as $field) {',
    "            self::compare('', $field, $before, $now, $changes);",
    '        }',
    '        return array_filter($changes, fn (array $items) => $items !== []);',
    '    }',
    '',
    '    /**',
    '     * @param array<mixed> $before',
    '     * @param array<mixed> $now',
    '     * @param array<string, array<string, mixed>> $changes',
    '     */',
    '    private static function compare(string $path, int|string $field, array $before, array $now, array &$changes): void',
    '    {',
    '        $old = $before[$field] ?? null;',
    '        $current = $now[$field] ?? null;',
    "        $bytes = fn (mixed $value) => (string) Document::fromPHP(['value' => $value]);",
    '        if ($bytes($old) === $bytes($current)) {',
    '            return;',
    '        }',
    '        $name = $path . $field;',
    '        if ($current === null) {',
    "            $changes['$unset'][$name] = '';",
    '        } elseif (is_array($old) && is_array($current) && !array_is_list($old) && !array_is_list($current)) {',
    '            foreach (array_keys($old + $current) as $item) {',
    "                self::compare($name . '.', $item, $old, $current, $changes);",
    '            }',
    '        } else {',
    "            $changes['$set'][$name] = $current;",
    '        }',
    '    }',
    '',
    '    /**',
    '     * Gives an identifier to the documents of a list that have none: MongoDB numbers only whole documents.',
    '     *',
    '     * @param list<array<string, mixed>>|null $items',
    '     * @return list<array<string, mixed>>|null',
    '     */',
    '    public static function identify(?array $items): ?array',
    '    {',
    "        return $items === null ? null : array_map(fn (mixed $item) => is_array($item) && !isset($item['_id']) ? [...$item, '_id' => (string) new ObjectId()] : $item, array_values($items));",
    '    }',
    '',
    '    /**',
    '     * What a value does not follow of its rule, each with the path of its field (`lines.0.quantity`). Fields the rules do not name are left alone.',
    '     *',
    '     * @param array<string, mixed> $rule',
    '     * @return list<FieldError>',
    '     */',
    '    public static function problems(mixed $value, array $rule, string $path): array',
    '    {',
    '        if ($value === null) {',
    "            return isset($rule['required']) ? [new FieldError($path, 'is required')] : [];",
    '        }',
    '        $errors = [];',
    "        if (isset($rule['items'])) {",
    '            if (!is_array($value) || !array_is_list($value)) {',
    "                return [new FieldError($path, 'must be a list')];",
    '            }',
    '            foreach ($value as $index => $item) {',
    "                $errors = [...$errors, ...self::problems($item, [...$rule['items'], 'required' => true], \"{$path}.{$index}\")];",
    '            }',
    '        }',
    "        if (isset($rule['fields'])) {",
    '            if (!is_array($value) || ($value !== [] && array_is_list($value))) {',
    "                return [new FieldError($path, 'must be a document')];",
    '            }',
    "            foreach ($rule['fields'] as $name => $field) {",
    '                $errors = [...$errors, ...self::problems($value[$name] ?? null, $field, "{$path}.{$name}")];',
    '            }',
    '        }',
    "        if (isset($rule['values']) && !in_array($value, $rule['values'])) {",
    "            $errors[] = new FieldError($path, 'must be one of: ' . implode(', ', $rule['values']));",
    '        }',
    '        $limits = [',
    "            'min' => ['>=', fn (float $limit) => (float) $value >= $limit],",
    "            'above' => ['>', fn (float $limit) => (float) $value > $limit],",
    "            'max' => ['<=', fn (float $limit) => (float) $value <= $limit],",
    "            'below' => ['<', fn (float $limit) => (float) $value < $limit],",
    '        ];',
    '        foreach ($limits as $name => [$sign, $fits]) {',
    '            if (isset($rule[$name]) && !$fits((float) $rule[$name])) {',
    '                $errors[] = new FieldError($path, "must be {$sign} {$rule[$name]}");',
    '            }',
    '        }',
    "        if (isset($rule['minLength']) && mb_strlen((string) $value) < $rule['minLength']) {",
    '            $errors[] = new FieldError($path, "must have >= {$rule[\'minLength\']} characters");',
    '        }',
    "        if (isset($rule['maxLength']) && mb_strlen((string) $value) > $rule['maxLength']) {",
    '            $errors[] = new FieldError($path, "is longer than {$rule[\'maxLength\']} characters");',
    '        }',
    '        return $errors;',
    '    }',
    '}',
  ])
}

function unitOfWork(context: Context, uses: PhpUses): Line[] {
  const properties = repositoryProperties(context, uses, (info) => info.attr)
  for (const info of context.tables) uses.add(className(namespaceOf(context, info, 'repository'), sqlRepositoryClass(info)))
  const operation = context.settings.transactions === 'operation'
  return [
    `/** The repositories over one Db${operation ? ', and its transaction: MongoDB has them on replica sets only' : ''}. */`,
    'final class SqlUnitOfWork implements UnitOfWork',
    '{',
    ...properties.map((line) => `    ${line}`),
    '',
    '    public function __construct(public readonly Db $db)',
    '    {',
    ...repositoryAssignments(context, (info) => `new ${sqlRepositoryClass(info)}($db)`).map((line) => `        ${line}`),
    '    }',
    '',
    '    public function transaction(callable $work): mixed',
    '    {',
    ...(operation
      ? [
          '        // Joins the transaction already open',
          '        if ($this->db->inTransaction()) {',
          '            return $work($this);',
          '        }',
          '        $this->db->begin();',
          '        try {',
          '            $result = $work($this);',
          '            $this->db->commit();',
          '            return $result;',
          '        } catch (\\Throwable $error) {',
          '            $this->db->rollBack();',
          '            throw $error;',
          '        }',
        ]
      : ['        return $work($this);']),
    '    }',
    '}',
  ]
}

/** An index of a collection, for the tests. */
function indexLines(context: Context): string[] {
  return context.tables.flatMap((info) => {
    const nullable = new Set(info.table.columns.filter((column) => column.nullable).map((column) => column.name))
    const index = (item: { name?: string; columns: string[] }, unique: boolean) => {
      const options = [
        ...(item.name ? [`'name' => ${phpString(item.name)}`] : []),
        ...(unique ? ["'unique' => true"] : []),
        ...(unique && item.columns.every((column) => nullable.has(column)) ? ["'sparse' => true"] : []),
      ]
      const keys = item.columns.map((column) => `${phpString(column)} => 1`).join(', ')
      return `        $db->collection(${phpString(info.name)})->createIndex([${keys}]${options.length > 0 ? `, [${options.join(', ')}]` : ''});`
    }
    return [...info.table.uniques.map((item) => index(item, true)), ...info.table.indexes.map((item) => index(item, false))]
  })
}

function testDatabase(context: Context): GeneratedFile[] {
  return [
    testFile('TestDatabase', new PhpUses(TESTS_NS).add(`${context.base}\\Database`, `${context.base}\\SqlUnitOfWork`), [
      '/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test. */',
      'final class TestDatabase',
      '{',
      '    public static function url(): ?string',
      '    {',
      "        $url = getenv('TEST_DATABASE_URL');",
      "        return is_string($url) && $url !== '' ? $url : null;",
      '    }',
      '',
      '    /** The repositories over the test database, with its collections and their indexes created again. */',
      '    public static function open(): SqlUnitOfWork',
      '    {',
      "        $db = Database::open(self::url() ?? throw new \\RuntimeException('The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)'));",
      '        $db->database->drop();',
      ...context.tables.map((info) => `        $db->database->createCollection(${phpString(info.name)});`),
      ...indexLines(context),
      '        return new SqlUnitOfWork($db);',
      '    }',
      '}',
    ]),
    testFile('DatabaseTest', new PhpUses(TESTS_NS).add(`${context.base}\\Database`, 'PHPUnit\\Framework\\TestCase'), [
      '/** The tests run on the database they were asked to. */',
      'final class DatabaseTest extends TestCase',
      '{',
      '    public function testIsTheOneTestDatabaseUrlNames(): void',
      '    {',
      '        self::assertSame(Database::name((string) TestDatabase::url()), TestDatabase::open()->db->database->getDatabaseName());',
      '    }',
      '}',
    ]),
  ]
}

export const mongodbOrm: PhpOrm = {
  id: 'mongophp',
  label: 'MongoDB PHP library 2',
  intro: 'plain entities, repositories and services with the MongoDB PHP library',
  documents: true,
  prefix: 'Mongo',
  property: (column) => fieldName(column.name),
  phpType,
  entityFile,
  databaseFiles: (context) => [databaseFile(context), dbFile(context), documentsFile(context)],
  repository: {
    doc: () => 'through the MongoDB library.',
    init,
    body,
    helpers,
  },
  unitOfWork,
  // Nothing is kept between reads but what each entity was
  forget: () => null,
  begin: (uow) => `${uow}->db->begin()`,
  close: (uow) => `${uow}->db->rollBack()`,
  testDatabase,
  require: () => ({ 'ext-mongodb': '^2.1', 'mongodb/mongodb': '^2.1' }),
  defaultUrl: () => URL,
  layout: () => [
    'src/Database.php             opens the database DATABASE_URL names',
    'src/Db.php                   a database and the session of its transaction',
    'src/Documents.php            values as MongoDB stores them, what changed, and the rules of nested documents',
  ],
}
