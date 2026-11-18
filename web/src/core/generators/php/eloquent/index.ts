/**
 * Eloquent 12 (illuminate/database, without Laravel) as a PHP ORM strategy (common/orm.ts): models with their casts,
 * a connection opened from DATABASE_URL through Capsule, repositories over the query builder that write by every
 * column of the key, the transaction of each operation on the connection, and tests whose tables the schema
 * builder creates as the database has them.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbColumn, DbTable } from '../../../schema/types.ts'
import type { Line } from '../../types.ts'
import {
  className,
  columnOf,
  errorClass,
  findInfo,
  namespaceOf,
  pathOf,
  phpFile,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from '../common/context.ts'
import type { PhpOrm } from '../common/orm.ts'
import { phpLiteral, phpString, PhpUses } from '../common/php.ts'
import { filledByDatabase, uuidFills, type RepositoryMethod } from '../common/repositories.ts'
import { repositoryAssignments, repositoryProperties } from '../common/support.ts'
import { schemasOf, testFile, TESTS_NS } from '../common/tests.ts'
import { eloquentModelFile, eloquentPhpType } from './models.ts'

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mariadb://app:app@localhost:3306/app',
  sqlite: 'sqlite:///app.db',
}

const DRIVERS: Record<string, string> = { postgresql: 'pdo_pgsql', mysql: 'pdo_mysql', mariadb: 'pdo_mysql', sqlite: 'pdo_sqlite' }

const ind = (items: Line[], spaces: number): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

function databaseFile(context: Context): GeneratedFile {
  return phpFile(
    pathOf(context.base, 'Database'),
    context.base,
    ['use Illuminate\\Database\\Capsule\\Manager;', 'use Illuminate\\Database\\Connection;'].join('\n'),
    [
      '/** The database DATABASE_URL names, through Eloquent. It never migrates: the database already exists. */',
      'final class Database',
      '{',
      `    public const DEFAULT_URL = ${phpString(URLS[context.settings.database] ?? URLS.postgresql)};`,
      '',
      '    /** The URL of DATABASE_URL, or the default one. */',
      '    public static function url(): string',
      '    {',
      "        $url = getenv('DATABASE_URL');",
      "        return is_string($url) && $url !== '' ? $url : self::DEFAULT_URL;",
      '    }',
      '',
      '    /** A connection to the database at $url (DATABASE_URL when null); the models use it from then on. */',
      '    public static function open(?string $url = null): Connection',
      '    {',
      '        $capsule = new Manager();',
      '        $capsule->addConnection(self::config($url ?? self::url()));',
      '        $capsule->bootEloquent();',
      '        return $capsule->getConnection();',
      '    }',
      '',
      '    /**',
      '     * The settings of the connection to a URL: postgresql://, mysql://, mariadb:// or sqlite:///<path> (sqlite:///:memory: for one in memory).',
      '     *',
      '     * @return array<string, mixed>',
      '     */',
      '    public static function config(string $url): array',
      '    {',
      "        if (str_starts_with($url, 'sqlite:')) {",
      "            $path = substr($url, strlen('sqlite:///'));",
      "            return ['driver' => 'sqlite', 'database' => $path !== '' ? $path : ':memory:', 'foreign_key_constraints' => true];",
      '        }',
      "        return ['url' => $url];",
      '    }',
      '}',
    ],
  )
}

// Repositories

const model = (info: TableInfo) => `${info.entity}::query()`

/** The calls that leave out rows marked as deleted. */
function softCalls(info: TableInfo): string[] {
  if (!info.soft) return []
  const name = phpString(info.soft.column.name)
  return info.soft.column.type.kind === 'boolean'
    ? [`->where(fn ($query) => $query->where(${name}, false)->orWhereNull(${name}))`]
    : [`->whereNull(${name})`]
}

const equals = (columns: ColumnInfo[], value: (column: ColumnInfo, index: number) => string) =>
  columns.map((column, index) => `->where(${phpString(column.column.name)}, ${value(column, index)})`)

const orderBy = (info: TableInfo) => info.key.map((column) => `->orderBy(${phpString(column.column.name)})`)

/** A statement of chained calls, one per line. */
const chain = (start: string, calls: string[]): string[] => [
  start,
  ...calls.map((call, index) => `    ${call}${index === calls.length - 1 ? ';' : ''}`),
]

/** The rows of the key of an entity as it was read: where it is, even when its key changed. */
const byKey = (info: TableInfo) => equals(info.key, (column) => `$entity->getOriginal(${phpString(column.column.name)})`)

function body(context: Context, info: TableInfo, method: RepositoryMethod, uses: PhpUses): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const given = equals(columns, (column) => `$${column.field}`)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return chain(`return ${model(info)}`, [...given, ...softCalls(info), '->first()'])
    case 'listByParent':
    case 'findAllBy':
      return chain(`return ${model(info)}`, [...given, ...softCalls(info), ...orderBy(info), '->get()', '->all()'])
    case 'list': {
      const start = softCalls(info).length > 0 ? chain(`$query = ${model(info)}`, softCalls(info)) : [`$query = ${model(info)};`]
      if (context.settings.paging === 'offset')
        return [
          ...start,
          '$total = (clone $query)->count();',
          ...chain('$items = $query', [...orderBy(info), '->offset($offset)', '->limit($limit)', '->get()', '->all()']),
          'return new Page($items, $total, $offset, $limit);',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const key = info.key
        const terms = key.map(
          (column, index) =>
            `fn ($query) => $query${key
              .slice(0, index)
              .map((before, position) => `->where(${phpString(before.column.name)}, $after[${position}])`)
              .join('')}->where(${phpString(column.column.name)}, '>', $after[${index}])`,
        )
        return [
          ...start,
          'if ($after !== null) {',
          key.length === 1
            ? `    $query->where(${phpString(key[0].column.name)}, '>', $after[0]);`
            : `    $query->where(fn ($query) => $query${terms.map((term, index) => `->${index === 0 ? 'where' : 'orWhere'}(${term})`).join('')});`,
          '}',
          ...chain('$rows = $query', [...orderBy(info), '->limit($limit + 1)', '->get()', '->all()']),
          '$items = array_slice($rows, 0, $limit);',
          `return new CursorPage($items, count($rows) > $limit ? [${key.map((column) => `$items[$limit - 1]->${column.prop}`).join(', ')}] : null);`,
        ]
      }
      return chain(`return ${model(info)}`, [...softCalls(info), ...orderBy(info), '->get()', '->all()'])
    }
    case 'insert': {
      // What the database filled is read back, by the key the row now has
      const reload = info.table.primaryKey !== null && filledByDatabase(info).length > 0
      return [
        ...uuidFills(context, info, uses),
        '$this->write(fn () => $entity->save());',
        ...(reload
          ? [
              ...chain(`$stored = ${model(info)}`, [...equals(info.key, (column) => `$entity->${column.prop}`), '->firstOrFail()']),
              '$entity->setRawAttributes($stored->getAttributes(), true);',
            ]
          : []),
        'return $entity;',
      ]
    }
    case 'update':
      return [
        '$changes = $entity->getDirty();',
        'if ($changes !== []) {',
        ...ind(chain(`$this->write(fn () => ${model(info)}`, [...byKey(info), '->update($changes))']), 4),
        '}',
        '$entity->syncOriginal();',
        'return $entity;',
      ]
    case 'delete':
      return [...chain(`$this->write(fn () => ${model(info)}`, [...byKey(info), '->delete())']), '$entity->exists = false;']
    default:
      return ["throw new \\LogicException('not supported');"]
  }
}

function helpers(context: Context, info: TableInfo, uses: PhpUses): Line[] {
  const writes = info.queries.some((item) => item.kind === 'insert' || item.kind === 'update' || item.kind === 'delete')
  if (!writes) return []
  uses.add('Illuminate\\Database\\QueryException', errorClass(context, 'ConflictException'))
  return [
    '    /** Runs a write; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */',
    '    private function write(callable $change): void',
    '    {',
    '        try {',
    '            $change();',
    '        } catch (QueryException $error) {',
    '            // SQLSTATE class 23: the change breaks a constraint',
    "            if (!str_starts_with((string) $error->getCode(), '23')) {",
    '                throw $error;',
    '            }',
    `            throw new ConflictException(${phpString(info.entity)}, 'the database refused the change: ' . $error->getMessage());`,
    '        }',
    '    }',
  ]
}

function unitOfWork(context: Context, uses: PhpUses): Line[] {
  uses.add('Illuminate\\Database\\Connection')
  const properties = repositoryProperties(context, uses, (info) => info.attr)
  for (const info of context.tables) uses.add(className(namespaceOf(context, info, 'repository'), sqlRepositoryClass(info)))
  const operation = context.settings.transactions === 'operation'
  return [
    '/** The repositories over the connection the models use, and its transaction. */',
    'final class SqlUnitOfWork implements UnitOfWork',
    '{',
    ...ind(properties, 4),
    '',
    '    public function __construct(public readonly Connection $db)',
    '    {',
    ...ind(
      repositoryAssignments(context, (info) => `new ${sqlRepositoryClass(info)}()`),
      8,
    ),
    '    }',
    '',
    '    public function transaction(callable $work): mixed',
    '    {',
    ...(operation
      ? [
          '        // Joins the transaction already open',
          '        if ($this->db->transactionLevel() > 0) {',
          '            return $work($this);',
          '        }',
          '        return $this->db->transaction(fn () => $work($this));',
        ]
      : ['        return $work($this);']),
    '    }',
    '}',
  ]
}

// Tests: the tables, created with the schema builder

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

/** The Blueprint call that creates a column. */
function columnCall(context: Context, table: DbTable, column: DbColumn, nativeEnum: boolean): string {
  const name = phpString(column.name)
  const type = column.type
  const identity = column.generated === 'identity' && table.primaryKey?.length === 1 && table.primaryKey[0] === column.name
  switch (type.kind) {
    case 'integer':
      // An identity key keeps its signed type (increments() would make it unsigned, unlike the columns pointing to it)
      return `$table->${type.bits === 64 ? 'bigInteger' : type.bits === 16 ? 'smallInteger' : 'integer'}(${name}${identity ? ', true' : ''})`
    case 'decimal':
      return `$table->decimal(${name}, ${type.precision ?? 10}, ${type.scale ?? 0})`
    case 'float':
      return type.bits === 32 ? `$table->float(${name})` : `$table->double(${name})`
    case 'text':
      if (type.length === undefined) return `$table->text(${name})`
      return `$table->${type.fixed ? 'char' : 'string'}(${name}, ${type.length})`
    case 'boolean':
      return `$table->boolean(${name})`
    case 'date':
      return `$table->date(${name})`
    case 'time':
      return `$table->${type.timezone ? 'timeTz' : 'time'}(${name})`
    case 'datetime':
      return `$table->${type.timezone ? 'dateTimeTz' : 'dateTime'}(${name})`
    case 'uuid':
      return `$table->uuid(${name})`
    case 'binary':
      return `$table->binary(${name})`
    case 'json':
    case 'array':
      return `$table->${context.settings.database === 'postgresql' && /jsonb/i.test(type.sql) ? 'jsonb' : 'json'}(${name})`
    case 'enum': {
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      // An enum of PostgreSQL is a type of its own: the column becomes it once the table exists
      return nativeEnum && context.settings.database !== 'postgresql'
        ? `$table->enum(${name}, [${values.map(phpString).join(', ')}])`
        : `$table->string(${name})`
    }
    case 'unknown':
      return `$table->string(${name})`
  }
}

function columnModifiers(column: DbColumn): string {
  const calls: string[] = []
  if (column.nullable) calls.push('->nullable()')
  if (column.generated === 'now') calls.push('->useCurrent()')
  else if (column.generated === 'onUpdateNow') calls.push('->useCurrent()', '->useCurrentOnUpdate()')
  else if (typeof column.generated === 'object') calls.push(`->storedAs(${phpString(column.generated.computed)})`)
  else if (column.default?.kind === 'literal') calls.push(`->default(${phpLiteral(column.default.value)})`)
  else if (column.default?.kind === 'expression') calls.push(`->default(new Expression(${phpString(column.default.sql)}))`)
  if (column.comment) calls.push(`->comment(${phpString(column.comment)})`)
  return calls.join('')
}

const ACTIONS: Record<string, string> = {
  cascade: 'cascade',
  'set null': 'set null',
  'set default': 'set default',
  restrict: 'restrict',
  'no action': 'no action',
}

/** Parents first, so every foreign key points to a table that exists (a cycle keeps the schema's order). */
function creationOrder(context: Context): TableInfo[] {
  const done: TableInfo[] = []
  const visiting = new Set<string>()
  const visit = (info: TableInfo) => {
    if (done.includes(info) || visiting.has(info.name)) return
    visiting.add(info.name)
    for (const key of info.table.foreignKeys) {
      const parent = findInfo(context, key.references.table)
      if (parent && parent !== info) visit(parent)
    }
    visiting.delete(info.name)
    done.push(info)
  }
  for (const info of context.tables) visit(info)
  return done
}

const tableName = (table: DbTable) => (table.schema ? `${table.schema}.${table.name}` : table.name)
const names = (items: string[]) => `[${items.map(phpString).join(', ')}]`

function createTable(context: Context, info: TableInfo, uses: PhpUses): string[] {
  const { table } = info
  const enums = new Set(context.schema.enums.filter((item) => item.storage === 'native').map((item) => item.name))
  const native = (column: DbColumn) => column.type.kind === 'enum' && enums.has(column.type.name) && context.settings.database !== 'sqlite'
  // A column of an enum of PostgreSQL takes its default once it has its type (the text default cannot be cast)
  const pgEnum = (column: DbColumn) => native(column) && context.settings.database === 'postgresql'
  const lines: string[] = []
  for (const column of table.columns) {
    if (column.default?.kind === 'expression') uses.add('Illuminate\\Database\\Query\\Expression')
    if (column.generated === 'identity' && !(table.primaryKey?.length === 1 && table.primaryKey[0] === column.name))
      lines.push('// TODO: the database numbers this column; the schema builder numbers only a key of one column')
    const modifiers = columnModifiers(pgEnum(column) ? { ...column, default: undefined } : column)
    lines.push(`${columnCall(context, table, column, native(column))}${modifiers};`)
  }
  const identityKey =
    table.primaryKey?.length === 1 && table.columns.find((column) => column.name === table.primaryKey![0])?.generated === 'identity'
  if (table.primaryKey && !identityKey) lines.push(`$table->primary(${names(table.primaryKey)});`)
  for (const unique of table.uniques)
    lines.push(`$table->unique(${names(unique.columns)}${unique.name ? `, ${phpString(unique.name)}` : ''});`)
  for (const index of table.indexes) lines.push(`$table->index(${names(index.columns)}${index.name ? `, ${phpString(index.name)}` : ''});`)
  for (const key of table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent) continue
    lines.push(
      `$table->foreign(${names(key.columns)}${key.name ? `, ${phpString(key.name)}` : ''})->references(${names(key.references.columns)})->on(${phpString(tableName(parent.table))})${key.onDelete ? `->onDelete(${phpString(ACTIONS[key.onDelete])})` : ''};`,
    )
  }
  for (const check of table.checks) lines.push(`// CHECK (${check.sql}): the schema builder has no CHECK constraints`)
  const qualified = table.schema ? `"${table.schema}"."${table.name}"` : `"${table.name}"`
  const after = table.columns.filter(pgEnum).flatMap((column) => {
    const type = column.type.kind === 'enum' ? column.type.name : ''
    const statements = [`ALTER TABLE ${qualified} ALTER COLUMN "${column.name}" TYPE "${type}" USING "${column.name}"::"${type}"`]
    if (column.default?.kind === 'literal' && column.default.value !== null)
      statements.push(
        `ALTER TABLE ${qualified} ALTER COLUMN "${column.name}" SET DEFAULT '${String(column.default.value).replace(/'/g, "''")}'`,
      )
    else if (column.default?.kind === 'expression')
      statements.push(`ALTER TABLE ${qualified} ALTER COLUMN "${column.name}" SET DEFAULT ${column.default.sql}`)
    return statements.map((sql) => `$schema->getConnection()->statement(${phpString(sql)});`)
  })
  return [
    `$schema->create(${phpString(tableName(table))}, function (Blueprint $table): void {`,
    ...lines.map((line) => `    ${line}`),
    '});',
    ...after,
  ]
}

function testDatabase(context: Context): GeneratedFile[] {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const uses = new PhpUses(TESTS_NS).add(
    `${context.base}\\Database`,
    `${context.base}\\SqlUnitOfWork`,
    'Illuminate\\Database\\Schema\\Blueprint',
    'Illuminate\\Database\\Schema\\Builder',
  )
  const enums = database === 'postgresql' ? context.schema.enums.filter((item) => item.storage === 'native') : []
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const namespaces = schemasOf(context)
  const tables = creationOrder(context).flatMap((info, index) => [...(index > 0 ? [''] : []), ...createTable(context, info, uses)])
  const files: GeneratedFile[] = [
    testFile('TestDatabase', uses, [
      sqlite
        ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, with every table created empty for every test. */'
        : `/** The test database: the ${NAMES[database]} database TEST_DATABASE_URL names, with every table created empty for every test. */`,
      'final class TestDatabase',
      '{',
      '    public static function url(): ?string',
      '    {',
      "        $url = getenv('TEST_DATABASE_URL');",
      "        return is_string($url) && $url !== '' ? $url : null;",
      '    }',
      '',
      '    /** The repositories over the test database, with every table dropped and created again. */',
      '    public static function open(): SqlUnitOfWork',
      '    {',
      ...(sqlite
        ? ["        $db = Database::open(self::url() ?? 'sqlite:///:memory:');"]
        : [
            '        // The tables are written for one kind of database: the tests cannot fall back to SQLite',
            `        $db = Database::open(self::url() ?? throw new \\RuntimeException(${phpString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)}));`,
          ]),
      '        $schema = $db->getSchemaBuilder();',
      '        $schema->dropAllTables();',
      ...(namespaces.length > 0 ? ['        // The schemas the tables are in, emptied and created again'] : []),
      ...namespaces.flatMap((name) => [
        `        $db->statement(${phpString(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)});`,
        `        $db->statement(${phpString(`CREATE SCHEMA "${name}"`)});`,
      ]),
      ...(enums.length > 0 ? ['        $schema->dropAllTypes();'] : []),
      ...enums.map(
        (item) => `        $db->statement(${phpString(`CREATE TYPE "${item.name}" AS ENUM (${item.values.map(quote).join(', ')})`)});`,
      ),
      '        self::createTables($schema);',
      '        return new SqlUnitOfWork($db);',
      '    }',
      '',
      '    /** Every table as the database has it, parents first. */',
      '    private static function createTables(Builder $schema): void',
      '    {',
      ...tables.map((line) => (line === '' ? '' : `        ${line}`)),
      '    }',
      '}',
    ]),
  ]
  const sql =
    database === 'postgresql'
      ? 'SELECT current_database() AS name'
      : sqlite
        ? 'SELECT sqlite_version() AS name'
        : 'SELECT DATABASE() AS name'
  files.push(
    testFile('DatabaseTest', new PhpUses(TESTS_NS).add('PHPUnit\\Framework\\TestCase'), [
      '/** The tests run on the database they were asked to. */',
      'final class DatabaseTest extends TestCase',
      '{',
      sqlite ? '    public function testIsSqlite(): void' : '    public function testIsTheOneTestDatabaseUrlNames(): void',
      '    {',
      '        $db = TestDatabase::open()->db;',
      `        $name = $db->selectOne(${phpString(sql)})->name;`,
      sqlite ? "        self::assertStringStartsWith('3.', $name);" : '        self::assertSame($db->getDatabaseName(), $name);',
      '        $db->disconnect();',
      '    }',
      '}',
    ]),
  )
  return files
}

export const eloquentOrm: PhpOrm = {
  id: 'eloquent',
  label: 'Eloquent 12',
  property: (column) => column.name,
  phpType: eloquentPhpType,
  entityFile: eloquentModelFile,
  databaseFiles: (context) => [databaseFile(context)],
  repository: {
    doc: () => 'through its Eloquent model and the query builder, by every column of its key.',
    init: () => [],
    body,
    helpers,
  },
  unitOfWork,
  forget: () => null,
  begin: (uow) => `${uow}->db->beginTransaction()`,
  close: (uow) => `${uow}->db->disconnect()`,
  testDatabase,
  require: (context) => ({
    [`ext-${DRIVERS[context.settings.database] ?? 'pdo_pgsql'}`]: '*',
    'illuminate/database': '^12.0',
  }),
  defaultUrl: (context) => URLS[context.settings.database] ?? URLS.postgresql,
  layout: () => ['src/Database.php             the connection of DATABASE_URL, which the models use'],
}
