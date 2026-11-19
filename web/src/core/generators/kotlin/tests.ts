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
import { nativeEnum } from './entities.ts'
import { KtImports, ktString } from './kotlin.ts'
import { missingValue, sampleValue } from './samples.ts'
import { EXPOSED_TRANSACTION } from './support.ts'

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
const testPath = (context: Context, name: string) => pathOf(context.base, name, true)
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
        if (column.column.nullable && isKey) return []
        return [`        ${column.prop} = ${sampleValue(column, info.table.checks, context.schema.enums, imports)},`]
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
    ]
  })
  return ktFile(testPath(context, 'Factories'), context.base, imports.write(), [
    '/** Rows for the tests: valid values for every column, and the rows they point to. */',
    'object Factories {',
    ...blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block]),
    '}',
  ])
}

// The test database

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

function testDatabaseFiles(context: Context): GeneratedFile[] {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const imports = new KtImports(context.base).add(
    'org.jetbrains.exposed.v1.jdbc.Database',
    'org.jetbrains.exposed.v1.jdbc.SchemaUtils',
    EXPOSED_TRANSACTION,
  )
  const tables = context.tables.filter((info) => info.writesEntity)
  for (const info of tables) imports.add(qualified(packageOf(context, info, 'entity'), info.tableObject))
  const postgres = database === 'postgresql'
  const schemas = postgres ? [...new Set(context.tables.map((info) => info.table.schema).filter((name): name is string => !!name))] : []
  const enums = postgres
    ? context.schema.enums.filter((item) =>
        context.tables.some((info) => info.columns.some((column) => nativeEnum(context, column.column) === item)),
      )
    : []
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const statement = (sql: string) => `            exec(${ktString(sql)})`
  if (sqlite) imports.add('java.io.File')
  const files: GeneratedFile[] = [
    ktFile(testPath(context, 'TestDatabase'), context.base, imports.write(), [
      sqlite
        ? '/** The test database: TEST_DATABASE_URL, or SQLite in a temporary file, created from the table objects before every test. */'
        : `/** The test database: the ${NAMES[database]} database TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the table objects before every test. */`,
      'object TestDatabase {',
      `    private val TABLES = arrayOf(${tables.map((info) => info.tableObject).join(', ')})`,
      '',
      '    /** The repositories over the test database, with every table dropped and created again. */',
      '    fun open(): SqlUnitOfWork {',
      '        val url = System.getenv("TEST_DATABASE_URL")',
      ...(sqlite
        ? [
            '        val db =',
            '            if (url == null) Database.connect("jdbc:sqlite:${File.createTempFile("test", ".db").absolutePath}?foreign_keys=true")',
            '            else Database.connect(url, user = System.getenv("TEST_DATABASE_USER") ?: "", password = System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
          ]
        : [
            '        // The table objects are written for one kind of database: the tests cannot fall back to SQLite',
            `        checkNotNull(url) { ${ktString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)} }`,
            '        val db = Database.connect(url, user = System.getenv("TEST_DATABASE_USER") ?: "", password = System.getenv("TEST_DATABASE_PASSWORD") ?: "")',
          ]),
      '        exposedTransaction(db) {',
      ...schemas.map((name) => statement(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)),
      '            SchemaUtils.drop(*TABLES)',
      ...enums.flatMap((item) => [
        statement(`DROP TYPE IF EXISTS "${item.name}" CASCADE`),
        statement(`CREATE TYPE "${item.name}" AS ENUM (${item.values.map(quote).join(', ')})`),
      ]),
      ...schemas.map((name) => statement(`CREATE SCHEMA "${name}"`)),
      '            SchemaUtils.create(*TABLES)',
      '        }',
      '        return SqlUnitOfWork(db)',
      '    }',
      '}',
    ]),
  ]
  const sql = database === 'postgresql' ? 'SELECT current_database()' : sqlite ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  files.push(
    ktFile(
      testPath(context, 'DatabaseTest'),
      context.base,
      new KtImports(context.base)
        .add(EXPOSED_TRANSACTION, 'kotlin.test.Test', 'kotlin.test.assertEquals', 'kotlin.test.assertTrue')
        .write(),
      [
        '/** The tests run on the database they were asked to. */',
        'class DatabaseTest {',
        '    @Test',
        sqlite ? '    fun isSqlite() {' : '    fun isTheOneTestDatabaseUrlNames() {',
        '        val uow = TestDatabase.open()',
        `        val value = exposedTransaction(uow.db) { exec(${ktString(sql)}) { it.next(); it.getString(1) } }`,
        sqlite
          ? '        assertTrue(value!!.startsWith("3."))'
          : '        assertEquals(System.getenv("TEST_DATABASE_URL")!!.substringAfterLast("/").substringBefore("?"), value)',
        '    }',
        '}',
      ],
    ),
  )
  return files
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

function repositoryTests(context: Context, info: TableInfo): string[][] {
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
        ...info.key.map((column) => `assertEquals(stored.${column.prop}, found.${column.prop})`),
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
  const version = (variable: string) => (info.version ? `, ${member(variable, info.version)}` : '')
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
              ...info.key.map((column) => `assertEquals(created.${column.prop}, found.${column.prop})`),
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

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [...testDatabaseFiles(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
  const assertions = [
    'kotlin.test.Test',
    'kotlin.test.BeforeTest',
    'kotlin.test.assertEquals',
    'kotlin.test.assertNotNull',
    'kotlin.test.assertNull',
    'kotlin.test.assertTrue',
  ]
  for (const info of makeable) {
    const entityClass = qualified(packageOf(context, info, 'entity'), info.entity)
    if (tests === 'all' || tests === 'repositories') {
      const imports = new KtImports(context.base).add(...assertions)
      const blocks = repositoryTests(context, info)
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
          '    }',
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
          '    }',
          ...blocks.flat(),
          ...helper,
          '}',
        ]),
      )
    }
  }
  return files
}
