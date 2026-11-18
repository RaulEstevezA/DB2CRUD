/**
 * The tests of a generated PHP project, which are also what the verification runs (PHPUnit): factories that build
 * valid rows (and their parents first), repository tests against a real database created from the mapping, and
 * service tests on the in-memory unit of work (or on the database when the project has no memory repositories).
 * The database is SQLite in memory unless TEST_DATABASE_URL names another. Mirrors csharp/tests.ts.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Line } from '../../types.ts'
import {
  className,
  columnOf,
  commonClass,
  errorClass,
  findInfo,
  namespaceOf,
  operationName,
  query,
  queryName,
  rootClass,
  serviceClass,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, partialUpdates, updateClass, updateColumns, updateType } from './dtos.ts'
import { access, phpString, PhpUses } from './php.ts'
import { missingValue, sampleValue } from './samples.ts'

const isNullableKey = (info: TableInfo, key: TableInfo['table']['foreignKeys'][number]) =>
  key.columns.every((name) => columnOf(info, name).column.nullable)

/** Tables whose rows the tests can make: they can be inserted, and so can the parents they need. */
function canMake(context: Context, info: TableInfo, seen = new Set<string>()): boolean {
  if (seen.has(info.name) || !query(info, 'insert')) return false
  const next = new Set(seen).add(info.name)
  return info.table.foreignKeys.every((key) => {
    if (isNullableKey(info, key)) return true
    const parent = findInfo(context, key.references.table)
    return parent !== undefined && canMake(context, parent, next)
  })
}

const newName = (info: TableInfo) => `new${info.entity}`
const addName = (info: TableInfo) => `add${info.entity}`
export const TESTS_NS = 'Tests'

/** A test file: one class, in the Tests namespace. */
export function testFile(name: string, uses: PhpUses, body: Line[]): GeneratedFile {
  const written = uses.write()
  return {
    path: `tests/${name}.php`,
    content: [
      '<?php',
      '',
      'declare(strict_types=1);',
      '',
      `namespace ${TESTS_NS};`,
      '',
      ...(written !== '' ? [written, ''] : []),
      ...body.filter((line): line is string => typeof line === 'string'),
      '',
    ].join('\n'),
  }
}

/** The schemas of PostgreSQL the tables are in (`sales` in `sales.orders`), which the tests empty with their tables. */
export function schemasOf(context: Context): string[] {
  if (context.settings.database !== 'postgresql') return []
  const names: string[] = []
  for (const info of context.tables) if (info.table.schema && !names.includes(info.table.schema)) names.push(info.table.schema)
  return names
}

const ind = (items: Line[], spaces: number): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

// Factories

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const uses = new PhpUses(TESTS_NS).add(rootClass(context, 'UnitOfWork'))
  const blocks = makeable.map((info) => {
    uses.add(className(namespaceOf(context, info, 'entity'), info.entity))
    const parents: string[] = []
    const fromParents: string[] = []
    const parentColumns = new Set<string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      uses.add(className(namespaceOf(context, parent, 'entity'), parent.entity))
      parents.push(`        $parent${index} = self::${addName(parent)}($uow, $n);`)
      key.columns.forEach((column, position) => {
        parentColumns.add(column)
        fromParents.push(
          `        ${access('$entity', columnOf(info, column).prop)} = ${access(`$parent${index}`, columnOf(parent, key.references.columns[position]).prop)};`,
        )
      })
    })
    const values = info.columns
      .filter((column) => !column.generated && !parentColumns.has(column.column.name))
      .flatMap((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        if (column === info.soft) return column.column.type.kind === 'boolean' ? [`        ${access('$entity', column.prop)} = false;`] : []
        if (column.column.nullable && isKey) return []
        return [`        ${access('$entity', column.prop)} = ${sampleValue(column, info.table.checks, context.schema.enums)};`]
      })
    const insert = query(info, 'insert')!
    return [
      `    /** A valid ${info.entity} that is not stored yet; $n makes its unique values differ. */`,
      `    public static function ${newName(info)}(int $n): ${info.entity}`,
      '    {',
      `        $entity = new ${info.entity}();`,
      ...values,
      '        return $entity;',
      '    }',
      '',
      `    /** A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}. */`,
      `    public static function ${addName(info)}(UnitOfWork $uow, int $n): ${info.entity}`,
      '    {',
      ...parents,
      `        $entity = self::${newName(info)}($n);`,
      ...fromParents,
      `        return $uow->${info.attr}->${queryName(context, insert)}($entity);`,
      '    }',
    ]
  })
  return testFile('Factories', uses, [
    '/** Rows for the tests: valid values for every column, and the rows they point to. */',
    'final class Factories',
    '{',
    ...blocks.flatMap((block, index) => [index > 0 ? '' : null, ...block]),
    '}',
  ])
}

// Tests of each table

/** A text column the tests can change and read back, when the table has one. */
function changeableText(info: TableInfo): ColumnInfo | undefined {
  return updateColumns(info).find(
    (column) =>
      column.column.type.kind === 'text' &&
      !column.column.type.fixed &&
      !info.hidden.includes(column.column.name) &&
      (column.column.type.length ?? 40) >= 7 &&
      !info.table.checks.some((check) => check.parsed?.column === column.column.name) &&
      !info.table.uniques.some((unique) => unique.columns.includes(column.column.name)) &&
      !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
  )
}

const test = (name: string, body: (Line | Line[])[]): Line[] => [
  '',
  `    public function test${name}(): void`,
  '    {',
  '        $uow = $this->uow;',
  ...ind(body.flat(), 8),
  '    }',
]

/** An assertion on a stored row's values, made only when those that may be null have one. */
function whenSet(columns: ColumnInfo[], assert: string): string[] {
  const optional = columns.filter((column) => column.column.nullable)
  if (optional.length === 0) return [assert]
  return [`if (${optional.map((column) => `${access('$stored', column.prop)} !== null`).join(' && ')}) {`, `    ${assert}`, '}']
}

function repositoryTests(context: Context, info: TableInfo): Line[][] {
  const repo = `$uow->${info.attr}`
  const keyOf = (variable: string) => info.key.map((column) => access(variable, column.prop)).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const forget = context.orm.forget('$uow')
  const tests: Line[][] = []
  const stored = `$stored = Factories::${addName(info)}($uow, 1);`
  tests.push(
    test('IsStoredAndReadBack', [
      stored,
      forget,
      getByKey && [
        `$found = ${repo}->${queryName(context, getByKey)}(${keyOf('$stored')});`,
        'self::assertNotNull($found);',
        ...info.key.map((column) => `self::assertEquals(${access('$stored', column.prop)}, ${access('$found', column.prop)});`),
      ],
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .flatMap((read) => {
          const columns = read.columns.map((name) => columnOf(info, name))
          return whenSet(
            columns,
            `self::assertNotNull(${repo}->${queryName(context, read)}(${columns.map((column) => access('$stored', column.prop)).join(', ')}));`,
          )
        }),
      ...info.table.foreignKeys
        .map((key) => query(info, 'listByParent', key.columns))
        .filter((item) => item !== undefined)
        .flatMap((read) => {
          const columns = read.columns.map((name) => columnOf(info, name))
          return whenSet(
            columns,
            `self::assertCount(1, ${repo}->${queryName(context, read)}(${columns.map((column) => access('$stored', column.prop)).join(', ')}));`,
          )
        }),
    ]),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test('ListsRowsByKey', [
        `Factories::${addName(info)}($uow, 1);`,
        `Factories::${addName(info)}($uow, 2);`,
        context.settings.paging === 'offset'
          ? [`$page = ${repo}->${name}(0, 1);`, 'self::assertSame(2, $page->total);', 'self::assertCount(1, $page->items);']
          : context.settings.paging === 'cursor'
            ? [
                `$first = ${repo}->${name}(null, 1);`,
                'self::assertCount(1, $first->items);',
                'self::assertNotNull($first->next);',
                `$second = ${repo}->${name}($first->next, 1);`,
                'self::assertCount(1, $second->items);',
                'self::assertNull($second->next);',
              ]
            : [`self::assertCount(2, ${repo}->${name}());`],
      ]),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test('StoresTheChanges', [
        stored,
        `${access('$stored', text.prop)} = 'changed';`,
        `${repo}->${queryName(context, update)}($stored);`,
        forget,
        `self::assertSame('changed', ${access(`${repo}->${queryName(context, getByKey)}(${keyOf('$stored')})`, text.prop)});`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test('IsDeleted', [
        stored,
        // Read before the delete: Doctrine empties the generated key of a removed entity
        ...info.key.map((column, index) => `$key${index} = ${access('$stored', column.prop)};`),
        `${repo}->${queryName(context, remove)}($stored);`,
        `self::assertNull(${repo}->${queryName(context, getByKey)}(${info.key.map((_, index) => `$key${index}`).join(', ')}));`,
      ]),
    )
  return tests
}

function serviceTests(context: Context, info: TableInfo, uses: PhpUses): Line[][] {
  const service = serviceClass(info)
  uses.add(className(namespaceOf(context, info, 'service'), service))
  const dtos = context.settings.serviceTypes === 'dtos'
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create')
  const get = op('get')
  const update = op('update') && query(info, 'update') && query(info, 'getByKey') ? op('update') : undefined
  const remove = op('delete')
  /** A column of what the service returns: a field of a DTO, or a property of the entity */
  const member = (variable: string, column: ColumnInfo) => (dtos ? `${variable}->${column.field}` : access(variable, column.prop))
  const keyOf = (variable: string) => info.key.map((column) => member(variable, column)).join(', ')
  // Rows go in through the service (when it creates them) and the parents through the factories
  const parentsFirst: string[] = []
  const overrides: { column: string; value: string }[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    parentsFirst.push(`$parent${index} = Factories::${addName(parent)}($uow, $n);`)
    key.columns.forEach((column, position) =>
      overrides.push({ column, value: access(`$parent${index}`, columnOf(parent, key.references.columns[position]).prop) }),
    )
  })
  // The parents take a number the rows of the test never take: a parent may be a row of the same table
  const start = [...(parentsFirst.length > 0 ? ['$n = 100;'] : []), ...parentsFirst]
  /** A row from the factory with the parents' keys and the given values set */
  const row = (variable: string, n: number, extra: { column: string; value: string }[] = []) => {
    const given = new Set(extra.map((item) => item.column))
    return [
      `$${variable} = Factories::${newName(info)}(${n});`,
      ...[...overrides.filter((item) => !given.has(item.column)), ...extra].map(
        (item) => `${access(`$${variable}`, columnOf(info, item.column).prop)} = ${item.value};`,
      ),
    ]
  }
  const input = (variable: string) => (dtos ? `self::createOf($${variable})` : `$${variable}`)
  /** The changes of an update that sets one field, and keeps the others as the row has them */
  const changes = (target: ColumnInfo, value: string, source: string) => {
    if (partialUpdates(context)) return `[${phpString(target.field)} => ${value}]`
    uses.add(updateClass(context, info))
    if (context.settings.updates === 'patch') {
      uses.add(commonClass(context, 'Patch'))
      return `new ${updateType(context, info)}(${target.field}: Patch::of(${value}))`
    }
    const fields = updateColumns(info).map((column) => `${column.field}: ${column === target ? value : access(source, column.prop)}`)
    return `new ${updateType(context, info)}(${fields.join(', ')})`
  }
  const version = (variable: string) => (info.version ? `, ${member(variable, info.version)}` : '')
  const fieldsOf = '$error->errors'
  const tests: Line[][] = []
  const open = [`$service = new ${service}($uow);`]
  if (create) {
    const name = operationName(context, create)
    tests.push(
      test('CreatesAValidRow', [
        ...open,
        ...start,
        ...row('row', 1),
        `$created = $service->${name}(${input('row')});`,
        get
          ? [
              `$found = $service->${operationName(context, get)}(${keyOf('$created')});`,
              ...info.key.map((column) => `self::assertEquals(${member('$created', column)}, ${member('$found', column)});`),
            ]
          : info.key.map((column) => `self::assertNotNull(${member('$created', column)});`),
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      uses.add(errorClass(context, 'ValidationFailedException'), errorClass(context, 'FieldError'))
      tests.push(
        test('RefusesAMissingValue', [
          ...open,
          ...start,
          ...row('row', 1, [{ column: required.column.name, value: 'null' }]),
          'try {',
          `    $service->${name}(${input('row')});`,
          `    self::fail(${phpString(`A ${info.entity} without ${required.column.name} was taken`)});`,
          '} catch (ValidationFailedException $error) {',
          `    self::assertSame([${phpString(required.column.name)}], array_map(fn (FieldError $item) => $item->field, ${fieldsOf}));`,
          '}',
        ]),
      )
    }
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      uses.add(errorClass(context, 'ConflictException'))
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        test('RefusesARepeatedUniqueValue', [
          ...open,
          ...start,
          ...row('row', 1),
          `$first = $service->${name}(${input('row')});`,
          ...row(
            'again',
            2,
            own.map((column) => ({ column: column.column.name, value: member('$first', column) })),
          ),
          '$this->expectException(ConflictException::class);',
          `$service->${name}(${input('again')});`,
        ]),
      )
      if (update && own.length === 1 && own.every((column) => !info.key.includes(column) && !column.generated)) {
        tests.push(
          test('KeepsItsOwnUniqueValue', [
            ...open,
            ...start,
            ...row('row', 1),
            `$created = $service->${name}(${input('row')});`,
            `$updated = $service->${operationName(context, update)}(${keyOf('$created')}, ${changes(own[0], member('$created', own[0]), '$row')}${version('$created')});`,
            `self::assertEquals(${member('$created', own[0])}, ${member('$updated', own[0])});`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      uses.add(errorClass(context, 'ValidationFailedException'), errorClass(context, 'FieldError'))
      const column = columnOf(info, parentKey.columns[0])
      tests.push(
        test('RefusesAMissingParent', [
          ...open,
          ...start,
          ...row('row', 1, [{ column: column.column.name, value: missingValue(column) }]),
          'try {',
          `    $service->${name}(${input('row')});`,
          `    self::fail(${phpString(`A ${info.entity} pointing to no ${parentKey.references.table} was taken`)});`,
          '} catch (ValidationFailedException $error) {',
          `    self::assertContains(${phpString(parentKey.columns[0])}, array_map(fn (FieldError $item) => $item->field, ${fieldsOf}));`,
          '}',
        ]),
      )
    }
  }
  if (get) {
    uses.add(errorClass(context, 'NotFoundException'))
    tests.push(
      test('SaysWhenARowIsMissing', [
        ...open,
        '$this->expectException(NotFoundException::class);',
        `$service->${operationName(context, get)}(${info.key.map((column) => missingValue(column)).join(', ')});`,
      ]),
    )
  }
  const text = changeableText(info)
  if (create && update && text)
    tests.push(
      test('ChangesARow', [
        ...open,
        ...start,
        ...row('row', 1),
        `$created = $service->${operationName(context, create)}(${input('row')});`,
        `$updated = $service->${operationName(context, update)}(${keyOf('$created')}, ${changes(text, "'changed'", '$row')}${version('$created')});`,
        `self::assertSame('changed', ${member('$updated', text)});`,
      ]),
    )
  if (create && remove && get) {
    uses.add(errorClass(context, 'NotFoundException'))
    tests.push(
      test('DeletesARow', [
        ...open,
        ...start,
        ...row('row', 1),
        `$created = $service->${operationName(context, create)}(${input('row')});`,
        // Read before the delete: Doctrine empties the generated key of a removed entity
        ...info.key.map((column, index) => `$key${index} = ${member('$created', column)};`),
        `$service->${operationName(context, remove)}(${info.key.map((_, index) => `$key${index}`).join(', ')}${version('$created')});`,
        '$this->expectException(NotFoundException::class);',
        `$service->${operationName(context, get)}(${info.key.map((_, index) => `$key${index}`).join(', ')});`,
      ]),
    )
  }
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields. */
function createOfHelper(context: Context, info: TableInfo, uses: PhpUses): Line[] {
  uses.add(className(namespaceOf(context, info, 'dtos'), createDto(info)))
  return [
    '',
    '    /** The create DTO of a row the factories made. */',
    `    private static function createOf(${info.entity} $row): ${createDto(info)}`,
    '    {',
    `        return new ${createDto(info)}(`,
    ...createColumns(info).map((column) => `            ${column.field}: ${access('$row', column.prop)},`),
    '        );',
    '    }',
  ]
}

/** The property, setup and teardown of a test class over the test database. */
function databaseMembers(context: Context, uses: PhpUses): Line[] {
  uses.add(rootClass(context, 'SqlUnitOfWork'))
  const caller = context.settings.transactions === 'caller'
  return [
    '    /** The repositories over the test database, opened empty for every test */',
    '    private SqlUnitOfWork $uow;',
    '',
    '    protected function setUp(): void',
    '    {',
    '        $this->uow = TestDatabase::open();',
    caller && '        // The caller owns the transaction: the test opens it, and it ends with the test',
    caller && `        ${context.orm.begin('$this->uow')};`,
    '    }',
    '',
    '    protected function tearDown(): void',
    '    {',
    `        ${context.orm.close('$this->uow')};`,
    '    }',
  ]
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [...context.orm.testDatabase(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
  for (const info of makeable) {
    const entityClass = className(namespaceOf(context, info, 'entity'), info.entity)
    if (tests === 'all' || tests === 'repositories') {
      const uses = new PhpUses(TESTS_NS).add('PHPUnit\\Framework\\TestCase')
      const members = databaseMembers(context, uses)
      files.push(
        testFile(`${info.entity}RepositoryTest`, uses, [
          `/** The repository of the "${info.name}" table, against the test database. */`,
          `final class ${info.entity}RepositoryTest extends TestCase`,
          '{',
          ...members,
          ...repositoryTests(context, info).flat(),
          '}',
        ]),
      )
    }
    if ((tests === 'all' || tests === 'services') && info.service !== null) {
      const uses = new PhpUses(TESTS_NS).add('PHPUnit\\Framework\\TestCase')
      const blocks = serviceTests(context, info, uses)
      if (blocks.length === 0) continue
      const dtosHelper =
        context.settings.serviceTypes === 'dtos' &&
        query(info, 'insert') &&
        info.operations.some((operation) => operation.kind === 'create')
      if (dtosHelper) uses.add(entityClass)
      const members = memory
        ? (uses.add(rootClass(context, 'MemoryUnitOfWork')),
          [
            '    private MemoryUnitOfWork $uow;',
            '',
            '    protected function setUp(): void',
            '    {',
            '        $this->uow = new MemoryUnitOfWork();',
            '    }',
          ])
        : databaseMembers(context, uses)
      files.push(
        testFile(`${serviceClass(info)}Test`, uses, [
          `/** The service of the "${info.name}" table, on ${memory ? 'the in-memory repositories' : 'the test database'}. */`,
          `final class ${serviceClass(info)}Test extends TestCase`,
          '{',
          ...members,
          ...blocks.flat(),
          ...(dtosHelper ? createOfHelper(context, info, uses) : []),
          '}',
        ]),
      )
    }
  }
  return files
}
