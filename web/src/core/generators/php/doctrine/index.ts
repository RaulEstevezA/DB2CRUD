/**
 * Doctrine ORM 3 (over DBAL 4) as a PHP ORM strategy (common/orm.ts): attribute-mapped entities, an EntityManager
 * opened from DATABASE_URL, repositories with the QueryBuilder that store every write at once (flush), the
 * transaction of each operation on the connection, and tests whose database SchemaTool creates from the mapping.
 */
import type { GeneratedFile } from '../../../export/files.ts'
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
import { fieldName, phpString, PhpUses } from '../common/php.ts'
import { uuidFills, type RepositoryMethod } from '../common/repositories.ts'
import { repositoryAssignments, repositoryProperties } from '../common/support.ts'
import { schemasOf, testFile, TESTS_NS } from '../common/tests.ts'
import { doctrineEntityFile, doctrinePhpType, idColumns, pgEnums, quoted } from './entities.ts'
import { PRECISE_TYPES, typeFiles, typesNamespace, usesPreciseTypes } from './types.ts'

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
  const precise = usesPreciseTypes(context)
  const uses = new PhpUses(context.base).add(
    'Doctrine\\DBAL\\DriverManager',
    'Doctrine\\DBAL\\Tools\\DsnParser',
    'Doctrine\\ORM\\EntityManager',
    'Doctrine\\ORM\\ORMSetup',
  )
  if (precise) {
    uses.add('Doctrine\\DBAL\\Types\\Type')
    for (const type of PRECISE_TYPES) uses.add(className(typesNamespace(context), type.name))
  }
  const registration = precise
    ? [
        '        // The timestamps of the entities keep their fractions of a second',
        ...PRECISE_TYPES.flatMap((type) => [
          `        if (!Type::hasType(${type.name}::NAME)) {`,
          `            Type::addType(${type.name}::NAME, ${type.name}::class);`,
          '        }',
        ]),
      ]
    : []
  return phpFile(pathOf(context.base, 'Database'), context.base, uses.write(), [
    '/** The database DATABASE_URL names, through Doctrine. It never migrates: the database already exists. */',
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
    '    /** An EntityManager over the database at $url (DATABASE_URL when null), with the mapping of the entities. */',
    '    public static function open(?string $url = null): EntityManager',
    '    {',
    ...registration,
    '        // The mapping is read from the attributes of the classes under src/',
    '        $config = ORMSetup::createAttributeMetadataConfiguration([__DIR__], true);',
    '        $config->enableNativeLazyObjects(true);',
    "        $parser = new DsnParser(['postgresql' => 'pdo_pgsql', 'postgres' => 'pdo_pgsql', 'mysql' => 'pdo_mysql', 'mariadb' => 'pdo_mysql', 'sqlite' => 'pdo_sqlite']);",
    '        $connection = DriverManager::getConnection($parser->parse($url ?? self::url()), $config);',
    '        return new EntityManager($connection, $config);',
    '    }',
    '}',
  ])
}

// Repositories

/** A condition that leaves out rows marked as deleted. */
function softCondition(info: TableInfo): string | null {
  if (!info.soft) return null
  const target = `e.${info.soft.prop}`
  return info.soft.column.type.kind === 'boolean' ? `(${target} = false OR ${target} IS NULL)` : `${target} IS NULL`
}

const orderBy = (info: TableInfo) => info.key.map((column, index) => `->${index === 0 ? 'orderBy' : 'addOrderBy'}('e.${column.prop}')`)

/** `->select('e')->from(...)` with the conditions and their parameters. */
function selectLines(info: TableInfo, columns: ColumnInfo[]): string[] {
  const conditions = [...columns.map((column, index) => `e.${column.prop} = :p${index}`), softCondition(info)].filter(
    (item): item is string => item !== null,
  )
  return [
    "->select('e')",
    `->from(${info.entity}::class, 'e')`,
    ...conditions.map((condition, index) => `->${index === 0 ? 'where' : 'andWhere'}(${phpString(condition)})`),
    ...columns.map((column, index) => `->setParameter('p${index}', $${column.field})`),
  ]
}

/** A statement of chained calls, one per line: `$a\n    ->b()\n    ->c();` */
const chain = (start: string, calls: string[]): string[] => [
  start,
  ...calls.map((call, index) => `    ${call}${index === calls.length - 1 ? ';' : ''}`),
]

function body(context: Context, info: TableInfo, method: RepositoryMethod, uses: PhpUses): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const qb = '$this->em->createQueryBuilder()'
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return chain(`return ${qb}`, [...selectLines(info, columns), '->getQuery()', '->getOneOrNullResult()'])
    case 'listByParent':
    case 'findAllBy':
      return chain(`return ${qb}`, [...selectLines(info, columns), ...orderBy(info), '->getQuery()', '->getResult()'])
    case 'list': {
      if (context.settings.paging === 'offset')
        return [
          ...chain(`$query = ${qb}`, selectLines(info, [])),
          `$total = (int) (clone $query)->select('COUNT(e.${idColumns(info)[0].prop})')->getQuery()->getSingleScalarResult();`,
          ...chain('$items = $query', [
            ...orderBy(info),
            '->setFirstResult($offset)',
            '->setMaxResults($limit)',
            '->getQuery()',
            '->getResult()',
          ]),
          'return new Page($items, $total, $offset, $limit);',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const key = info.key
        const after = key
          .map((column, index) =>
            [...key.slice(0, index).map((before, position) => `e.${before.prop} = :k${position}`), `e.${column.prop} > :k${index}`].join(
              ' AND ',
            ),
          )
          .map((item) => (key.length > 1 ? `(${item})` : item))
          .join(' OR ')
        return [
          ...chain(`$query = ${qb}`, selectLines(info, [])),
          'if ($after !== null) {',
          `    $query->andWhere(${phpString(after)})`,
          ...key.map((_, index) => `        ->setParameter('k${index}', $after[${index}])${index === key.length - 1 ? ';' : ''}`),
          '}',
          ...chain('$rows = $query', [...orderBy(info), '->setMaxResults($limit + 1)', '->getQuery()', '->getResult()']),
          '$items = array_slice($rows, 0, $limit);',
          `return new CursorPage($items, count($rows) > $limit ? [${key.map((column) => `$items[$limit - 1]->${column.prop}`).join(', ')}] : null);`,
        ]
      }
      return chain(`return ${qb}`, [...selectLines(info, []), ...orderBy(info), '->getQuery()', '->getResult()'])
    }
    case 'insert':
      return [...uuidFills(context, info, uses), '$this->em->persist($entity);', '$this->flush();', 'return $entity;']
    case 'update':
      return ['$this->flush();', 'return $entity;']
    case 'delete':
      return ['$this->em->remove($entity);', '$this->flush();']
    default:
      return ["throw new \\LogicException('not supported');"]
  }
}

function helpers(context: Context, info: TableInfo, uses: PhpUses): Line[] {
  const writes = info.queries.some((item) => item.kind === 'insert' || item.kind === 'update' || item.kind === 'delete')
  if (!writes) return []
  uses.add('Doctrine\\DBAL\\Exception\\ConstraintViolationException', errorClass(context, 'ConflictException'))
  return [
    '    /**',
    '     * Stores the pending changes; a database refusal (a unique value, a row still pointed to) becomes a ConflictException.',
    '     * Doctrine closes the EntityManager when the database refuses a change: open another one to go on.',
    '     */',
    '    private function flush(): void',
    '    {',
    '        try {',
    '            $this->em->flush();',
    '        } catch (ConstraintViolationException $error) {',
    `            throw new ConflictException(${phpString(info.entity)}, 'the database refused the change: ' . $error->getMessage());`,
    '        }',
    '    }',
  ]
}

function unitOfWork(context: Context, uses: PhpUses): Line[] {
  uses.add('Doctrine\\ORM\\EntityManagerInterface')
  const properties = repositoryProperties(context, uses, (info) => info.attr)
  for (const info of context.tables) uses.add(className(namespaceOf(context, info, 'repository'), sqlRepositoryClass(info)))
  const operation = context.settings.transactions === 'operation'
  return [
    '/** The repositories over one EntityManager, and the transaction of its connection. */',
    'final class SqlUnitOfWork implements UnitOfWork',
    '{',
    ...ind(properties, 4),
    '',
    '    public function __construct(public readonly EntityManagerInterface $em)',
    '    {',
    ...ind(
      repositoryAssignments(context, (info) => `new ${sqlRepositoryClass(info)}($em)`),
      8,
    ),
    '    }',
    '',
    '    public function transaction(callable $work): mixed',
    '    {',
    ...(operation
      ? [
          '        $connection = $this->em->getConnection();',
          '        // Joins the transaction already open',
          '        if ($connection->isTransactionActive()) {',
          '            return $work($this);',
          '        }',
          '        $connection->beginTransaction();',
          '        try {',
          '            $result = $work($this);',
          '            $this->em->flush();',
          '            $connection->commit();',
          '            return $result;',
          '        } catch (\\Throwable $error) {',
          '            $connection->rollBack();',
          '            $this->em->clear();',
          '            throw $error;',
          '        }',
        ]
      : ['        return $work($this);']),
    '    }',
    '}',
  ]
}

// Tests

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

const ACTIONS: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET NULL',
  'set default': 'SET DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'NO ACTION',
}

const tableName = (info: TableInfo) => (info.table.schema ? `${info.table.schema}.${info.name}` : info.name)
const list = (names: string[]) => `[${names.map((name) => phpString(quoted(name))).join(', ')}]`

function testDatabase(context: Context): GeneratedFile[] {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const uses = new PhpUses(TESTS_NS).add(`${context.base}\\Database`, `${context.base}\\SqlUnitOfWork`, 'Doctrine\\ORM\\Tools\\SchemaTool')
  const enums = pgEnums(context)
  const additions: string[] = []
  for (const info of context.tables) {
    for (const key of info.table.foreignKeys) {
      const parent = findInfo(context, key.references.table)
      if (!parent) continue
      const options = key.onDelete ? `['onDelete' => ${phpString(ACTIONS[key.onDelete])}]` : '[]'
      additions.push(
        `$schema->getTable(${phpString(tableName(info))})->addForeignKeyConstraint(${phpString(tableName(parent))}, ${list(key.columns)}, ${list(key.references.columns)}, ${options}${key.name ? `, ${phpString(key.name)}` : ''});`,
      )
    }
    if (!info.table.primaryKey) additions.push(`$schema->getTable(${phpString(tableName(info))})->dropPrimaryKey();`)
  }
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const namespaces = schemasOf(context)
  const files: GeneratedFile[] = [
    testFile('TestDatabase', uses, [
      sqlite
        ? '/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from the mapping for every test. */'
        : `/** The test database: the ${NAMES[database]} database TEST_DATABASE_URL names, created empty from the mapping for every test. */`,
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
        ? ["        $em = Database::open(self::url() ?? 'sqlite:///:memory:');"]
        : [
            '        // The mapping is written for one kind of database: the tests cannot fall back to SQLite',
            `        $em = Database::open(self::url() ?? throw new \\RuntimeException(${phpString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)}));`,
          ]),
      '        $connection = $em->getConnection();',
      '        $tool = new SchemaTool($em);',
      ...(namespaces.length > 0 ? ['        // The schemas the tables are in go too: the mapping creates them again'] : []),
      ...namespaces.map((name) => `        $connection->executeStatement(${phpString(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)});`),
      ...(enums.length > 0
        ? ['        // DBAL cannot read a column of an enum type: the types go first, and their columns with them']
        : []),
      ...enums.map((item) => `        $connection->executeStatement(${phpString(`DROP TYPE IF EXISTS "${item.name}" CASCADE`)});`),
      '        $tool->dropDatabase();',
      ...enums.map(
        (item) =>
          `        $connection->executeStatement(${phpString(`CREATE TYPE "${item.name}" AS ENUM (${item.values.map(quote).join(', ')})`)});`,
      ),
      '        $schema = $tool->getSchemaFromMetadata($em->getMetadataFactory()->getAllMetadata());',
      ...(additions.length > 0
        ? [
            '        // What the mapping does not say: the foreign keys, and the tables that have no primary key',
            ...additions.map((line) => `        ${line}`),
          ]
        : []),
      '        foreach ($schema->toSql($connection->getDatabasePlatform()) as $sql) {',
      '            $connection->executeStatement($sql);',
      '        }',
      '        return new SqlUnitOfWork($em);',
      '    }',
      '}',
    ]),
  ]
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  files.push(
    testFile('DatabaseTest', new PhpUses(TESTS_NS).add('PHPUnit\\Framework\\TestCase'), [
      '/** The tests run on the database they were asked to. */',
      'final class DatabaseTest extends TestCase',
      '{',
      sqlite ? '    public function testIsSqlite(): void' : '    public function testIsTheOneTestDatabaseUrlNames(): void',
      '    {',
      '        $connection = TestDatabase::open()->em->getConnection();',
      sqlite
        ? `        self::assertStringStartsWith('3.', (string) $connection->fetchOne(${phpString(sql)}));`
        : `        self::assertSame($connection->getDatabase(), $connection->fetchOne(${phpString(sql)}));`,
      '        $connection->close();',
      '    }',
      '}',
    ]),
  )
  return files
}

export const doctrineOrm: PhpOrm = {
  id: 'doctrine',
  label: 'Doctrine ORM 3',
  property: (column) => fieldName(column.name),
  phpType: doctrinePhpType,
  entityFile: doctrineEntityFile,
  databaseFiles: (context) => [databaseFile(context), ...typeFiles(context)],
  repository: {
    doc: () => "through Doctrine's EntityManager; every write is flushed at once.",
    init: (_context, _info, uses) => {
      uses.add('Doctrine\\ORM\\EntityManagerInterface')
      return ['    public function __construct(private readonly EntityManagerInterface $em)', '    {', '    }']
    },
    body,
    helpers,
  },
  unitOfWork,
  forget: (uow) => `${uow}->em->clear();`,
  begin: (uow) => `${uow}->em->getConnection()->beginTransaction()`,
  close: (uow) => `${uow}->em->getConnection()->close()`,
  testDatabase,
  require: (context) => ({
    [`ext-${DRIVERS[context.settings.database] ?? 'pdo_pgsql'}`]: '*',
    'doctrine/dbal': '^4.3',
    'doctrine/orm': '^3.5',
    'symfony/cache': '^7.3 || ^8.0',
  }),
  defaultUrl: (context) => URLS[context.settings.database] ?? URLS.postgresql,
  layout: () => ['src/Database.php             the EntityManager of DATABASE_URL, with the mapping of the entities'],
}
