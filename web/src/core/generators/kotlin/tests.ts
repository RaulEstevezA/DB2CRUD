/**
 * The tests of a generated Kotlin project, which are also what the verification runs (kotlin.test on JUnit 5):
 * factories that build valid rows (and their parents first), repository tests against a real database created from
 * the table objects, and service tests on the in-memory unit of work (or on the database when the project has no
 * memory repositories). The database is SQLite in a temporary file unless TEST_DATABASE_URL names another. Mirrors
 * php/common/tests.ts.
 */
import type { GeneratedFile } from '../../export/files.ts'
import {
  columnOf,
  commonPackage,
  errorsPackage,
  findInfo,
  ktFile,
  operationName,
  packageOf,
  pathOf,
  qualified,
  query,
  queryName,
  serviceClass,
  stored,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, updateClass, updateColumns, updateType } from './dtos.ts'
import type { DbType } from '../../schema/types.ts'
import { listOf, type ListInfo, type NestedClass } from './documents.ts'
import { KtImports, ktString, typeName } from './kotlin.ts'
import { missingValue, sampleValue } from './samples.ts'

const isNullableKey = (info: TableInfo, key: TableInfo['table']['foreignKeys'][number]) =>
  key.columns.every((name) => columnOf(info, name).column.nullable)

/** Tables whose rows the tests can make: they can be inserted, and so can the parents they need. */
export function canMake(context: Context, info: TableInfo, seen = new Set<string>()): boolean {
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
export const testPath = (context: Context, name: string) => pathOf(context.base, name, true)
const ind = (items: string[], spaces: number) => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))

// Factories

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const imports = new KtImports(context.base)
  const blocks = makeable.map((info) => {
    imports.add(qualified(packageOf(context, info, 'entity'), info.entity))
    const parents: string[] = []
    const fromParents: string[] = []
    const parentColumns = new Set<string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      parents.push(`        val parent${index} = ${addName(parent)}(uow, n)`)
      key.columns.forEach((column, position) => {
        parentColumns.add(column)
        fromParents.push(
          `        entity.${columnOf(info, column).prop} = parent${index}.${columnOf(parent, key.references.columns[position]).prop}`,
        )
      })
    })
    const values = info.columns
      .filter((column) => !column.generated && !parentColumns.has(column.column.name))
      .flatMap((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        if (column === info.soft) return column.column.type.kind === 'boolean' ? [`        ${column.prop} = false,`] : []
        // No sample is sure to fit a type that is not known
        if (column.column.nullable && (isKey || column.column.type.kind === 'unknown')) return []
        const value =
          documentValue(info, column) ??
          (column.column.type.kind === 'array'
            ? context.orm.emptyList(context)
            : sampleValue(column, info.table.checks, context.schema.enums, imports))
        return [`        ${column.prop} = ${value},`]
      })
    const insert = query(info, 'insert')!
    return [
      `    /** A valid ${info.entity} that is not stored yet; n makes its unique values differ. */`,
      `    fun ${newName(info)}(n: Int): ${info.entity} =`,
      `        ${info.entity}(`,
      ...values.map((line) => `    ${line}`),
      '        )',
      '',
      `    /** A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}. */`,
      `    fun ${addName(info)}(uow: UnitOfWork, n: Int): ${info.entity} {`,
      ...parents,
      `        val entity = ${newName(info)}(n)`,
      ...fromParents,
      `        return uow.${info.attr}.${queryName(context, insert)}(entity)`,
      '    }',
      ...[...info.nested.values()].flatMap((item) => nestedFactories(context, item, imports)),
    ]
  })
  return ktFile(testPath(context, 'Factories'), context.base, imports.write(), [
    '/** Rows for the tests: valid values for every column, and the rows they point to. */',
    'object Factories {',
    ...blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block]),
    '}',
  ])
}

// Nested documents

const factoryOf = (item: NestedClass) => `new${item.path.split('.').join('')}`

/** A column that holds documents, or a list of them, as a Kotlin expression; null for any other. */
function documentValue(info: TableInfo, column: ColumnInfo): string | null {
  const nested = info.nested.get(column.column.name)
  return nested ? nestedValue(column.column.type, nested) : null
}

const nestedValue = (type: DbType, nested: NestedClass): string =>
  type.kind === 'array' ? `listOf(${nestedValue(type.items, nested)})` : `${factoryOf(nested)}(n)`

/** A factory per class of nested document, without the identifier it is given when it is stored. */
function nestedFactories(context: Context, item: NestedClass, imports: KtImports): string[] {
  const values = item.fields
    .filter((field) => field.column.name !== '_id' && field.column.type.kind !== 'unknown')
    .map((field) => {
      if (/\bInstant\b/.test(field.kt)) imports.add('java.time.Instant')
      if (/\bBigDecimal\b/.test(field.kt)) imports.add('java.math.BigDecimal')
      if (/\bUUID\b/.test(field.kt)) imports.add('java.util.UUID')
      const column = { column: field.column, kt: field.kt, ktImport: null } as ColumnInfo
      const value = field.nested
        ? nestedValue(field.column.type, field.nested)
        : field.column.type.kind === 'array'
          ? context.orm.emptyList(context)
          : sampleValue(column, field.column.checks ?? [], context.schema.enums, imports)
      return `            ${field.prop} = ${value},`
    })
  return [
    '',
    `    /** A valid ${item.path}; n makes its values differ. */`,
    `    fun ${factoryOf(item)}(n: Int): ${item.path} =`,
    `        ${item.path}(`,
    ...values,
    '        )',
    ...item.classes.flatMap((inner) => nestedFactories(context, inner, imports)),
  ]
}

/** A value for an item of a list, as a Kotlin expression of n. */
function itemSample(context: Context, list: ListInfo, imports: KtImports): string {
  if (list.nested && list.type.kind === 'json') return `Factories.${factoryOf(list.nested)}(n)`
  if (list.type.kind === 'array') return context.orm.emptyList(context)
  return sampleValue({ ...list.column, column: { ...list.column.column, type: list.type }, kt: list.kt }, [], context.schema.enums, imports)
}

const itemTest = (list: ListInfo) => `addsAndRemovesOneItemOf${typeName(list.column.key)}`

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

const test = (name: string, body: (string | string[] | false | null | undefined)[]): string[] => [
  '',
  '    @Test',
  `    fun ${name}() {`,
  ...ind(
    body.flat().filter((line): line is string => typeof line === 'string'),
    8,
  ),
  '    }',
]

/** An assertion on a stored row's values, made only when those that may be null have one. */
function whenSet(columns: ColumnInfo[], assert: string): string[] {
  const optional = columns.filter((column) => column.column.nullable)
  if (optional.length === 0) return [assert]
  return [`if (${optional.map((column) => `stored.${column.prop} != null`).join(' && ')}) ${assert}`]
}

/** The assertion that two values of a column are the same: arrays are compared by what they hold. */
const same = (column: ColumnInfo) => (column.kt === 'ByteArray' ? 'kotlin.test.assertContentEquals' : 'assertEquals')

function repositoryTests(context: Context, info: TableInfo, imports: KtImports): string[][] {
  const repo = `uow.${info.attr}`
  const keyOf = (variable: string) => info.key.map((column) => stored(`${variable}.${column.prop}`, column)).join(', ')
  const args = (columns: ColumnInfo[]) => columns.map((column) => `stored.${column.prop}!!`).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const tests: string[][] = []
  const stored1 = `val stored = Factories.${addName(info)}(uow, 1)`
  tests.push(
    test('isStoredAndReadBack', [
      stored1,
      getByKey && [
        `val found = ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`,
        'assertNotNull(found)',
        ...info.key.map((column) => `${same(column)}(stored.${column.prop}, found.${column.prop})`),
      ],
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .flatMap((read) => {
          const columns = read.columns.map((name) => columnOf(info, name))
          return whenSet(columns, `assertNotNull(${repo}.${queryName(context, read)}(${args(columns)}))`)
        }),
      ...info.table.foreignKeys
        .map((key) => query(info, 'listByParent', key.columns))
        .filter((item) => item !== undefined)
        .flatMap((read) => {
          const columns = read.columns.map((name) => columnOf(info, name))
          return whenSet(columns, `assertEquals(1, ${repo}.${queryName(context, read)}(${args(columns)}).size)`)
        }),
    ]),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test('listsRowsByKey', [
        `Factories.${addName(info)}(uow, 1)`,
        `Factories.${addName(info)}(uow, 2)`,
        context.settings.paging === 'offset'
          ? [`val page = ${repo}.${name}(0, 1)`, 'assertEquals(2L, page.total)', 'assertEquals(1, page.items.size)']
          : context.settings.paging === 'cursor'
            ? [
                `val first = ${repo}.${name}(null, 1)`,
                'assertEquals(1, first.items.size)',
                'assertNotNull(first.next)',
                `val second = ${repo}.${name}(first.next, 1)`,
                'assertEquals(1, second.items.size)',
                'assertNull(second.next)',
              ]
            : [`assertEquals(2, ${repo}.${name}().size)`],
      ]),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test('storesTheChanges', [
        stored1,
        `stored.${text.prop} = "changed"`,
        `${repo}.${queryName(context, update)}(stored)`,
        `assertEquals("changed", ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})?.${text.prop})`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test('isDeleted', [
        stored1,
        `${repo}.${queryName(context, remove)}(stored)`,
        `assertNull(${repo}.${queryName(context, getByKey)}(${keyOf('stored')}))`,
      ]),
    )
  for (const adding of info.queries.filter((item) => item.kind === 'addItem')) {
    const list = listOf(info, adding)
    const removing = query(info, 'removeItem', adding.columns)
    if (!removing || !getByKey) continue
    if (list.column.ktImport) imports.add(list.column.ktImport)
    const items = (variable: string) => `${variable}.${list.column.prop}.orEmpty()`
    const which = list.by === 'id' ? `${items('added')}[before].id!!` : list.by === 'value' ? 'item' : `before, ${items('added')}.size`
    const removeItem = `${repo}.${queryName(context, removing)}(${keyOf('stored')}`
    tests.push(
      test(itemTest(list), [
        'val n = 7',
        stored1,
        `val before = ${items('stored')}.size`,
        `val item: ${list.kt} = ${itemSample(context, list, imports)}`,
        `val added = ${repo}.${queryName(context, adding)}(${keyOf('stored')}, item)!!`,
        `assertEquals(before + 1, ${items('added')}.size)`,
        `val removed = ${removeItem}, ${which})!!`,
        `assertEquals(before, ${items('removed')}.size)`,
        list.by === 'position' && `assertNull(${removeItem}, 0, before + 5))`,
      ]),
    )
  }
  return tests
}

function serviceTests(context: Context, info: TableInfo, imports: KtImports): string[][] {
  const service = serviceClass(info)
  imports.add(qualified(packageOf(context, info, 'service'), service))
  const dtos = context.settings.serviceTypes === 'dtos'
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create')
  const get = op('get')
  const update = op('update') && query(info, 'update') && query(info, 'getByKey') ? op('update') : undefined
  const remove = op('delete')
  /** A column of what the service returns, known to be set */
  const member = (variable: string, column: ColumnInfo) =>
    dtos ? `${variable}.${column.prop}` : stored(`${variable}.${column.prop}`, column)
  const keyOf = (variable: string) => info.key.map((column) => member(variable, column)).join(', ')
  // Rows go in through the service (when it creates them) and the parents through the factories, numbered 100: the
  // rows of the test never take that number, and a parent may be a row of the same table
  const parentsFirst: string[] = []
  const overrides: { column: string; value: string }[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    parentsFirst.push(`val parent${index} = Factories.${addName(parent)}(uow, 100)`)
    key.columns.forEach((column, position) =>
      overrides.push({ column, value: `parent${index}.${columnOf(parent, key.references.columns[position]).prop}` }),
    )
  })
  const row = (variable: string, n: number, extra: { column: string; value: string }[] = []) => {
    const given = new Set(extra.map((item) => item.column))
    return [
      `val ${variable} = Factories.${newName(info)}(${n})`,
      ...[...overrides.filter((item) => !given.has(item.column)), ...extra].map(
        (item) => `${variable}.${columnOf(info, item.column).prop} = ${item.value}`,
      ),
    ]
  }
  const input = (variable: string) => (dtos ? `createOf(${variable})` : variable)
  /** The changes of an update that sets one field, and keeps the others as the row has them */
  const changes = (target: ColumnInfo, value: string, source: string) => {
    imports.add(updateClass(context, info))
    const mode = context.settings.updates
    if (mode === 'patch') {
      imports.add(qualified(commonPackage(context), 'Patch'))
      return `${updateType(context, info)}(${target.prop} = Patch.of(${value}))`
    }
    if (mode === 'optional') {
      imports.add('java.util.Optional')
      return `${updateType(context, info)}(${target.prop} = Optional.of(${value}))`
    }
    const fields = updateColumns(info).map(
      (column) => `${column.prop} = ${column === target ? value : stored(`${source}.${column.prop}`, column)}`,
    )
    return `${updateType(context, info)}(${fields.join(', ')})`
  }
  const version = (variable: string) => (info.version ? `, ${member(variable, info.version)}${info.version.column.nullable ? '!!' : ''}` : '')
  const tests: string[][] = []
  const open = [`val service = ${service}(uow)`]
  if (create) {
    const name = operationName(context, create)
    tests.push(
      test('createsAValidRow', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `val created = service.${name}(${input('row')})`,
        get
          ? [
              `val found = service.${operationName(context, get)}(${keyOf('created')})`,
              ...info.key.map((column) => `${same(column)}(created.${column.prop}, found.${column.prop})`),
            ]
          : info.key.map((column) => `assertNotNull(created.${column.prop})`),
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      imports.add(qualified(errorsPackage(context), 'ValidationFailedException'), 'kotlin.test.assertFailsWith')
      tests.push(
        test('refusesAMissingValue', [
          ...open,
          ...parentsFirst,
          ...row('row', 1, [{ column: required.column.name, value: 'null' }]),
          `val error = assertFailsWith<ValidationFailedException> { service.${name}(${input('row')}) }`,
          `assertEquals(listOf(${ktString(required.column.name)}), error.errors.map { it.field })`,
        ]),
      )
    }
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      imports.add(qualified(errorsPackage(context), 'ConflictException'), 'kotlin.test.assertFailsWith')
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        test('refusesARepeatedUniqueValue', [
          ...open,
          ...parentsFirst,
          ...row('row', 1),
          `val first = service.${name}(${input('row')})`,
          ...row(
            'again',
            2,
            own.map((column) => ({ column: column.column.name, value: `first.${column.prop}` })),
          ),
          `assertFailsWith<ConflictException> { service.${name}(${input('again')}) }`,
        ]),
      )
      if (update && own.length === 1 && own.every((column) => !info.key.includes(column) && !column.generated)) {
        // The value it already has; Optional.of takes it only as known to be set
        const kept =
          context.settings.updates === 'optional' && own[0].column.nullable ? `${member('created', own[0])}!!` : member('created', own[0])
        tests.push(
          test('keepsItsOwnUniqueValue', [
            ...open,
            ...parentsFirst,
            ...row('row', 1),
            `val created = service.${name}(${input('row')})`,
            `val updated = service.${operationName(context, update)}(${keyOf('created')}, ${changes(own[0], kept, 'row')}${version('created')})`,
            `assertEquals(created.${own[0].prop}, updated.${own[0].prop})`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      imports.add(qualified(errorsPackage(context), 'ValidationFailedException'), 'kotlin.test.assertFailsWith')
      const column = columnOf(info, parentKey.columns[0])
      tests.push(
        test('refusesAMissingParent', [
          ...open,
          ...parentsFirst,
          ...row('row', 1, [{ column: column.column.name, value: missingValue(column, imports) }]),
          `val error = assertFailsWith<ValidationFailedException> { service.${name}(${input('row')}) }`,
          `assertTrue(${ktString(parentKey.columns[0])} in error.errors.map { it.field })`,
        ]),
      )
    }
  }
  if (get) {
    imports.add(qualified(errorsPackage(context), 'NotFoundException'), 'kotlin.test.assertFailsWith')
    tests.push(
      test('saysWhenARowIsMissing', [
        ...open,
        `assertFailsWith<NotFoundException> { service.${operationName(context, get)}(${info.key.map((column) => missingValue(column, imports)).join(', ')}) }`,
      ]),
    )
  }
  const text = changeableText(info)
  if (create && update && text)
    tests.push(
      test('changesARow', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `val created = service.${operationName(context, create)}(${input('row')})`,
        `val updated = service.${operationName(context, update)}(${keyOf('created')}, ${changes(text, '"changed"', 'row')}${version('created')})`,
        `assertEquals("changed", updated.${text.prop})`,
      ]),
    )
  if (create && remove && get) {
    imports.add(qualified(errorsPackage(context), 'NotFoundException'), 'kotlin.test.assertFailsWith')
    tests.push(
      test('deletesARow', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `val created = service.${operationName(context, create)}(${input('row')})`,
        `service.${operationName(context, remove)}(${keyOf('created')}${version('created')})`,
        `assertFailsWith<NotFoundException> { service.${operationName(context, get)}(${keyOf('created')}) }`,
      ]),
    )
  }
  for (const operation of info.operations.filter((item) => item.kind === 'addItem')) {
    const list = listOf(info, operation)
    const without = op('removeItem', operation.columns)
    if (!create || !without || info.hidden.includes(list.column.column.name)) continue
    if (list.column.ktImport) imports.add(list.column.ktImport)
    imports.add(qualified(errorsPackage(context), 'NotFoundException'), 'kotlin.test.assertFailsWith')
    // A DTO says when the list is never missing
    const items = (variable: string) =>
      dtos && !list.column.column.nullable ? `${variable}.${list.column.prop}` : `${variable}.${list.column.prop}.orEmpty()`
    const which = list.by === 'id' ? `${items('added')}[before].id!!` : list.by === 'value' ? 'item' : 'before'
    const missing = list.by === 'id' ? `"${'f'.repeat(24)}"` : list.by === 'value' ? null : '99'
    const removeItem = `service.${operationName(context, without)}(${keyOf('created')}`
    tests.push(
      test(itemTest(list), [
        'val n = 7',
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `val created = service.${operationName(context, create)}(${input('row')})`,
        `val before = ${items('created')}.size`,
        `val item: ${list.kt} = ${itemSample(context, list, imports)}`,
        `val added = service.${operationName(context, operation)}(${keyOf('created')}, item${version('created')})`,
        `assertEquals(before + 1, ${items('added')}.size)`,
        `val removed = ${removeItem}, ${which}${version('added')})`,
        `assertEquals(before, ${items('removed')}.size)`,
        missing !== null && `assertFailsWith<NotFoundException> { ${removeItem}, ${missing}${version('removed')}) }`,
      ]),
    )
  }
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields. */
function createOfHelper(context: Context, info: TableInfo, imports: KtImports): string[] {
  imports.add(qualified(packageOf(context, info, 'dtos'), createDto(info)))
  return [
    '',
    '    /** The create DTO of a row the factories made. */',
    `    private fun createOf(row: ${info.entity}) = ${createDto(info)}(`,
    ...createColumns(info).map((column) => `        ${column.prop} = row.${column.prop},`),
    '    )',
  ]
}

/** What a test class over the test database does after opening the unit of work, and when a test ends. */
export const openTest = (context: Context) => context.orm.openTest(context).map((line) => `        ${line}`)
export const closeTest = (context: Context) =>
  context.orm.closeTest.length > 0
    ? ['', '    @AfterTest', '    fun close() {', ...context.orm.closeTest.map((line) => `        ${line}`), '    }']
    : []

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [...context.orm.testDatabaseFiles(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
  const assertions = [
    'kotlin.test.Test',
    'kotlin.test.BeforeTest',
    ...(context.orm.closeTest.length > 0 ? ['kotlin.test.AfterTest'] : []),
    'kotlin.test.assertEquals',
    'kotlin.test.assertNotNull',
    'kotlin.test.assertNull',
    'kotlin.test.assertTrue',
  ]
  for (const info of makeable) {
    const entityClass = qualified(packageOf(context, info, 'entity'), info.entity)
    if (tests === 'all' || tests === 'repositories') {
      const imports = new KtImports(context.base).add(...assertions)
      const blocks = repositoryTests(context, info, imports)
      files.push(
        ktFile(testPath(context, `${info.entity}RepositoryTest`), context.base, imports.write(), [
          `/** The repository of the "${info.name}" table, against the test database. */`,
          `class ${info.entity}RepositoryTest {`,
          '    /** The repositories over the test database, opened empty for every test */',
          '    private lateinit var uow: SqlUnitOfWork',
          '',
          '    @BeforeTest',
          '    fun open() {',
          '        uow = TestDatabase.open()',
          ...openTest(context),
          '    }',
          ...closeTest(context),
          ...blocks.flat(),
          '}',
        ]),
      )
    }
    if ((tests === 'all' || tests === 'services') && info.service !== null) {
      const imports = new KtImports(context.base).add(...assertions)
      const blocks = serviceTests(context, info, imports)
      if (blocks.length === 0) continue
      const dtosHelper =
        context.settings.serviceTypes === 'dtos' &&
        query(info, 'insert') &&
        info.operations.some((operation) => operation.kind === 'create')
      if (dtosHelper) imports.add(entityClass)
      const helper = dtosHelper ? createOfHelper(context, info, imports) : []
      files.push(
        ktFile(testPath(context, `${serviceClass(info)}Test`), context.base, imports.write(), [
          `/** The service of the "${info.name}" table, on ${memory ? 'the in-memory repositories' : 'the test database'}. */`,
          `class ${serviceClass(info)}Test {`,
          memory ? '    private lateinit var uow: MemoryUnitOfWork' : '    private lateinit var uow: SqlUnitOfWork',
          '',
          '    @BeforeTest',
          '    fun open() {',
          memory ? '        uow = MemoryUnitOfWork()' : '        uow = TestDatabase.open()',
          ...(memory ? [] : openTest(context)),
          '    }',
          ...(memory ? [] : closeTest(context)),
          ...blocks.flat(),
          ...helper,
          '}',
        ]),
      )
    }
  }
  return files
}
