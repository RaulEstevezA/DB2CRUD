/**
 * The tests of a generated Java project, which are also what the verification runs (JUnit): factories that build
 * valid rows (and their parents first), repository tests against a real database created from the entities, and
 * service tests on the in-memory unit of work (or on the database when the project has no memory repositories).
 * The database is SQLite in a file of target/ unless TEST_DATABASE_URL names another. Mirrors
 * typescript/common/tests.ts.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines, type Line } from '../types.ts'
import { javaPath, javaString, JavaImports } from './java.ts'
import {
  columnOf,
  commonPackage,
  errorsPackage,
  findInfo,
  operationName,
  qualified,
  query,
  queryName,
  serviceClass,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { accessor, createColumns, createDto, updateColumns, updatePackage, updateType } from './dtos.ts'
import { enumTypes } from './entities.ts'
import { missingValue, sampleImports, sampleValue } from './samples.ts'

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
const pkgOf = (context: Context) => context.base

// Factories

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const pkg = pkgOf(context)
  const imports = new JavaImports(pkg)
  const blocks = makeable.map((info) => {
    imports.add(qualified(context, info, 'entity', info.entity))
    const parents: string[] = []
    const fromParents: string[] = []
    const parentColumns = new Set<string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      imports.add(qualified(context, parent, 'entity', parent.entity))
      parents.push(`        ${parent.entity} parent${index} = ${addName(parent)}(uow, n);`)
      key.columns.forEach((column, position) => {
        parentColumns.add(column)
        fromParents.push(
          `        entity.${columnOf(info, column).setter}(parent${index}.${columnOf(parent, key.references.columns[position]).getter}());`,
        )
      })
    })
    const values = info.columns
      .filter((column) => !column.generated && !parentColumns.has(column.column.name))
      .flatMap((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        if (column === info.soft) return column.column.type.kind === 'boolean' ? [`        entity.${column.setter}(false);`] : []
        if (column.column.nullable && isKey) return []
        for (const name of sampleImports(column)) imports.add(name)
        return [`        entity.${column.setter}(${sampleValue(column, info.table.checks, context.schema.enums)});`]
      })
    const insert = query(info, 'insert')!
    return [
      `    /** A valid ${info.entity} that is not stored yet; n makes its unique values differ. */`,
      `    static ${info.entity} ${newName(info)}(int n) {`,
      `        ${info.entity} entity = new ${info.entity}();`,
      ...values,
      '        return entity;',
      '    }',
      '',
      `    /** A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}. */`,
      `    static ${info.entity} ${addName(info)}(UnitOfWork uow, int n) {`,
      ...parents,
      `        ${info.entity} entity = ${newName(info)}(n);`,
      ...fromParents,
      `        return uow.${info.attr}().${queryName(context, insert)}(entity);`,
      '    }',
    ]
  })
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    '/** Rows for the tests: valid values for every column, and the rows they point to. */',
    'final class Factories {',
    '    private Factories() {}',
    ...blocks.flatMap((block) => ['', ...block]),
    '}',
    '',
  )
  return { path: javaPath(pkg, 'Factories', true), content }
}

// The test database

function testDatabaseFile(context: Context): GeneratedFile {
  const pkg = pkgOf(context)
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const types = enumTypes(context)
  const imports = new JavaImports(pkg).add('jakarta.persistence.EntityManager', 'jakarta.persistence.EntityManagerFactory')
  if (types.length > 0) imports.add('java.sql.Connection', 'java.sql.DriverManager', 'java.sql.SQLException', 'java.sql.Statement')
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    sqlite
      ? '/** The test database: TEST_DATABASE_URL, or SQLite in a file of target/, created from the entities before every test. */'
      : '/** The test database: the one TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the entities before every test. */',
    'final class TestDatabase {',
    sqlite
      ? '    static final String URL = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:sqlite:target/test.db?foreign_keys=true");'
      : [
          '    // The entities are written for one kind of database: the tests cannot fall back to SQLite',
          '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        ],
    '    static final String USER = System.getenv("TEST_DATABASE_USER");',
    '    static final String PASSWORD = System.getenv("TEST_DATABASE_PASSWORD");',
    '',
    '    private static EntityManagerFactory factory;',
    '',
    '    private TestDatabase() {}',
    '',
    '    /** An EntityManager over the test database, with every table dropped and created again from the entities. */',
    '    static synchronized EntityManager open() {',
    !sqlite && [
      '        if (URL == null)',
      `            throw new IllegalStateException("The database tests need a disposable ${{ postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }[database as 'postgresql']} database: set TEST_DATABASE_URL (it is emptied)");`,
    ],
    '        if (factory == null) {',
    types.length > 0 && '            createTypes();',
    '            factory = Database.configuration(URL, USER, PASSWORD).createEntityManagerFactory();',
    '        }',
    '        factory.getSchemaManager().drop(true);',
    '        factory.getSchemaManager().create(true);',
    '        return factory.createEntityManager();',
    '    }',
    types.length > 0 && [
      '',
      '    /** The enum types of the database the entities use, which Hibernate does not create. */',
      '    private static void createTypes() {',
      '        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD); Statement statement = connection.createStatement()) {',
      ...types.map(
        (sql) => `            statement.execute(${javaString(`DO $$ BEGIN ${sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)});`,
      ),
      '        } catch (SQLException error) {',
      '            throw new IllegalStateException(error);',
      '        }',
      '    }',
    ],
    '}',
    '',
  )
  return { path: javaPath(pkg, 'TestDatabase', true), content }
}

function databaseTestFile(context: Context): GeneratedFile {
  const pkg = pkgOf(context)
  const database = context.settings.database
  const query =
    database === 'postgresql' ? 'SELECT current_database()' : database === 'sqlite' ? 'SELECT sqlite_version()' : 'SELECT DATABASE()'
  const content = lines(
    `package ${pkg};`,
    '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    database === 'sqlite' && 'import static org.junit.jupiter.api.Assertions.assertTrue;',
    '',
    'import jakarta.persistence.EntityManager;',
    database !== 'sqlite' && 'import java.net.URI;',
    'import org.junit.jupiter.api.Test;',
    '',
    '/** The tests run on the database they were asked to. */',
    'class DatabaseTest {',
    '    @Test',
    database === 'sqlite' ? '    void isSqlite() {' : '    void isTheOneTestDatabaseUrlNames() {',
    '        EntityManager entityManager = TestDatabase.open();',
    `        Object result = entityManager.createNativeQuery(${javaString(query)}).getSingleResult();`,
    '        entityManager.close();',
    database === 'sqlite'
      ? '        assertTrue(String.valueOf(result).startsWith("3."));'
      : '        assertEquals(URI.create(TestDatabase.URL.substring("jdbc:".length())).getPath().substring(1), String.valueOf(result));',
    '    }',
    '}',
    '',
  )
  return { path: javaPath(pkg, 'DatabaseTest', true), content }
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
  '        @Test',
  `        void ${name}() {`,
  ...body.flat().map((line) => (typeof line === 'string' ? `            ${line}` : line)),
  '        }',
]

function repositoryTests(context: Context, info: TableInfo): Line[][] {
  const repo = `uow.${info.attr}()`
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.getter}()`).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const tests: Line[][] = []
  const stored = `${info.entity} stored = Factories.${addName(info)}(uow, 1);`
  tests.push(
    test('isStoredAndReadBack', [
      stored,
      'uow.entityManager().clear();',
      getByKey && [
        `${info.entity} found = ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).orElseThrow();`,
        ...info.key.map((column) => `assertEquals(stored.${column.getter}(), found.${column.getter}());`),
      ],
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .map(
          (read) =>
            `assertTrue(${repo}.${queryName(context, read)}(${read.columns.map((name) => `stored.${columnOf(info, name).getter}()`).join(', ')}).isPresent());`,
        ),
      ...info.table.foreignKeys
        .map((key) => query(info, 'listByParent', key.columns))
        .filter((item) => item !== undefined)
        .map((read) => {
          const args = read.columns.map((name) => `stored.${columnOf(info, name).getter}()`)
          return `if (${args.map((arg) => `${arg} != null`).join(' && ')}) assertEquals(1, ${repo}.${queryName(context, read)}(${args.join(', ')}).size());`
        }),
    ]),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test('listsRowsByKey', [
        `Factories.${addName(info)}(uow, 1);`,
        `Factories.${addName(info)}(uow, 2);`,
        context.settings.paging === 'offset'
          ? [`var page = ${repo}.${name}(0, 1);`, 'assertEquals(2, page.total());', 'assertEquals(1, page.items().size());']
          : context.settings.paging === 'cursor'
            ? [
                `var first = ${repo}.${name}(null, 1);`,
                'assertEquals(1, first.items().size());',
                'assertNotNull(first.next());',
                `var second = ${repo}.${name}(first.next(), 1);`,
                'assertEquals(1, second.items().size());',
                'assertNull(second.next());',
              ]
            : [`assertEquals(2, ${repo}.${name}().size());`],
      ]),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test('storesTheChanges', [
        stored,
        `stored.${text.setter}("changed");`,
        `${repo}.${queryName(context, update)}(stored);`,
        'uow.entityManager().clear();',
        `assertEquals("changed", ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).orElseThrow().${text.getter}());`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test('isDeleted', [
        stored,
        `${repo}.${queryName(context, remove)}(stored);`,
        `assertTrue(${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).isEmpty());`,
      ]),
    )
  return tests
}

function serviceTests(context: Context, info: TableInfo, imports: JavaImports): Line[][] {
  const service = serviceClass(info)
  imports.add(qualified(context, info, 'service', service))
  const dtos = context.settings.serviceTypes === 'dtos'
  const record = context.settings.dtoKind !== 'class'
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create')
  const get = op('get')
  const update = op('update') && query(info, 'update') && query(info, 'getByKey') ? op('update') : undefined
  const remove = op('delete')
  /** A value of a created row: an entity's getter, or a read DTO's accessor */
  const valueOf = (variable: string, column: ColumnInfo) =>
    dtos ? `${variable}.${accessor(context, column.prop, record)}` : `${variable}.${column.getter}()`
  const keyOf = (variable: string) => info.key.map((column) => valueOf(variable, column)).join(', ')
  // Rows go in through the service (when it creates them) and the parents through the factories
  const parentsFirst: string[] = []
  const overrides: { column: string; value: string }[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    imports.add(qualified(context, parent, 'entity', parent.entity))
    parentsFirst.push(`${parent.entity} parent${index} = Factories.${addName(parent)}(uow, n);`)
    key.columns.forEach((column, position) =>
      overrides.push({ column, value: `parent${index}.${columnOf(parent, key.references.columns[position]).getter}()` }),
    )
  })
  const start = ['int n = 1;', ...parentsFirst]
  /** A row from the factory with the parents' keys and the given values set */
  const row = (variable: string, n: number, extra: { column: string; value: string }[] = []) => {
    const given = new Set(extra.map((item) => item.column))
    return [
      `${info.entity} ${variable} = Factories.${newName(info)}(${n});`,
      ...[...overrides.filter((item) => !given.has(item.column)), ...extra].map(
        (item) => `${variable}.${columnOf(info, item.column).setter}(${item.value});`,
      ),
    ]
  }
  const input = (variable: string) => (dtos ? `createOf(${variable})` : variable)
  /** The changes of an update that sets one field, and keeps the others as the row has them */
  const changes = (target: ColumnInfo, value: string, source: string) => {
    imports.add(`${updatePackage(context, info)}.${updateType(context, info)}`)
    if (context.settings.updates === 'patch') imports.add(`${commonPackage(context)}.Patch`)
    if (context.settings.updates === 'optional') imports.add('java.util.Optional')
    const fields = updateColumns(info).map((column) => {
      if (context.settings.updates === 'patch') return column === target ? `Patch.of(${value})` : 'Patch.absent()'
      if (context.settings.updates === 'optional') return column === target ? `Optional.of(${value})` : 'null'
      return column === target ? value : `${source}.${column.getter}()`
    })
    return `new ${updateType(context, info)}(${fields.join(', ')})`
  }
  const version = (variable: string) => (info.version ? `, ${valueOf(variable, info.version)}` : '')
  const tests: Line[][] = []
  const open = [`${service} service = new ${service}(uow);`]
  if (create) {
    const name = operationName(context, create)
    tests.push(
      test('createsAValidRow', [
        ...open,
        ...start,
        ...row('row', 1),
        `var created = service.${name}(${input('row')});`,
        get && [
          `var found = service.${operationName(context, get)}(${keyOf('created')});`,
          ...info.key.map((column) => `assertEquals(${valueOf('created', column)}, ${valueOf('found', column)});`),
        ],
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      imports.add(`${errorsPackage(context)}.ValidationFailedException`, `${errorsPackage(context)}.FieldError`, 'java.util.List')
      tests.push(
        test('refusesAMissingValue', [
          ...open,
          ...start,
          ...row('row', 1, [{ column: required.column.name, value: 'null' }]),
          `ValidationFailedException error = assertThrows(ValidationFailedException.class, () -> service.${name}(${input('row')}));`,
          `assertEquals(List.of(${javaString(required.column.name)}), error.getErrors().stream().map(FieldError::field).toList());`,
        ]),
      )
    }
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      imports.add(`${errorsPackage(context)}.ConflictException`)
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        test('refusesARepeatedUniqueValue', [
          ...open,
          ...start,
          ...row('row', 1),
          `var first = service.${name}(${input('row')});`,
          ...row(
            'again',
            2,
            own.map((column) => ({ column: column.column.name, value: valueOf('first', column) })),
          ),
          `assertThrows(ConflictException.class, () -> service.${name}(${input('again')}));`,
        ]),
      )
      // A row keeps its own unique value when it changes: the check must not take it for another row
      if (update && own.length === 1 && own.every((column) => !info.key.includes(column) && !column.generated)) {
        tests.push(
          test('keepsItsOwnUniqueValue', [
            ...open,
            ...start,
            ...row('row', 1),
            `var created = service.${name}(${input('row')});`,
            `service.${operationName(context, update)}(${keyOf('created')}, ${changes(own[0], valueOf('created', own[0]), 'row')}${version('created')});`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      imports.add(`${errorsPackage(context)}.ValidationFailedException`, `${errorsPackage(context)}.FieldError`)
      const column = columnOf(info, parentKey.columns[0])
      for (const name of sampleImports(column)) imports.add(name)
      tests.push(
        test('refusesAMissingParent', [
          ...open,
          ...start,
          ...row('row', 1, [{ column: column.column.name, value: missingValue(column) }]),
          `ValidationFailedException error = assertThrows(ValidationFailedException.class, () -> service.${name}(${input('row')}));`,
          `assertTrue(error.getErrors().stream().map(FieldError::field).toList().contains(${javaString(parentKey.columns[0])}));`,
        ]),
      )
    }
  }
  if (get) {
    imports.add(`${errorsPackage(context)}.NotFoundException`)
    for (const column of info.key) for (const name of sampleImports(column)) imports.add(name)
    tests.push(
      test('saysWhenARowIsMissing', [
        ...open,
        `assertThrows(NotFoundException.class, () -> service.${operationName(context, get)}(${info.key.map((column) => missingValue(column)).join(', ')}));`,
      ]),
    )
  }
  const text = changeableText(info)
  if (create && update && text)
    tests.push(
      test('changesARow', [
        ...open,
        ...start,
        ...row('row', 1),
        `var created = service.${operationName(context, create)}(${input('row')});`,
        `var updated = service.${operationName(context, update)}(${keyOf('created')}, ${changes(text, '"changed"', 'row')}${version('created')});`,
        `assertEquals("changed", ${valueOf('updated', text)});`,
      ]),
    )
  if (create && remove && get) {
    imports.add(`${errorsPackage(context)}.NotFoundException`)
    tests.push(
      test('deletesARow', [
        ...open,
        ...start,
        ...row('row', 1),
        `var created = service.${operationName(context, create)}(${input('row')});`,
        `service.${operationName(context, remove)}(${keyOf('created')}${version('created')});`,
        `assertThrows(NotFoundException.class, () -> service.${operationName(context, get)}(${keyOf('created')}));`,
      ]),
    )
  }
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields. */
function createOfHelper(context: Context, info: TableInfo, imports: JavaImports): Line[] {
  imports.add(qualified(context, info, 'dtos', createDto(info)))
  return [
    '',
    '    /** The create DTO of a row the factories made. */',
    `    private static ${createDto(info)} createOf(${info.entity} row) {`,
    `        return new ${createDto(info)}(${createColumns(info)
      .map((column) => `row.${column.getter}()`)
      .join(', ')});`,
    '    }',
  ]
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [testDatabaseFile(context), databaseTestFile(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
  const caller = context.settings.transactions === 'caller'
  const pkg = pkgOf(context)
  for (const info of makeable) {
    const className = `${info.entity}Test`
    const imports = new JavaImports(pkg)
      .add('org.junit.jupiter.api.Nested', 'org.junit.jupiter.api.Test', qualified(context, info, 'entity', info.entity))
      .addStatic(
        'org.junit.jupiter.api.Assertions.assertEquals',
        'org.junit.jupiter.api.Assertions.assertNotNull',
        'org.junit.jupiter.api.Assertions.assertNull',
        'org.junit.jupiter.api.Assertions.assertThrows',
        'org.junit.jupiter.api.Assertions.assertTrue',
      )
    const nested: (Line | Line[])[] = []
    let database = false
    if (tests === 'all' || tests === 'repositories') {
      nested.push('', '    @Nested', '    class Repository {', ...repositoryTests(context, info).flat(), '    }')
      database = true
    }
    const withService = (tests === 'all' || tests === 'services') && info.service !== null
    if (withService) {
      const serviceBlocks = serviceTests(context, info, imports)
      if (serviceBlocks.length > 0) {
        const unit = memory ? '        private final MemoryUnitOfWork uow = new MemoryUnitOfWork();' : null
        if (!memory) database = true
        nested.push('', '    @Nested', `    class ${serviceClass(info)}Test {`, unit, ...serviceBlocks.flat(), '    }')
        if (
          context.settings.serviceTypes === 'dtos' &&
          query(info, 'insert') &&
          info.operations.some((operation) => operation.kind === 'create')
        )
          nested.push(...createOfHelper(context, info, imports))
      }
    }
    if (nested.length === 0) continue
    if (database) imports.add('jakarta.persistence.EntityManager', 'org.junit.jupiter.api.AfterEach', 'org.junit.jupiter.api.BeforeEach')
    const content = lines(
      `package ${pkg};`,
      '',
      imports.write(),
      '',
      `/** Tests of the "${info.name}" table. */`,
      `class ${className} {`,
      database && [
        '    private EntityManager entityManager;',
        '    /** The repositories over the test database, opened empty for every test */',
        '    private SqlUnitOfWork uow;',
        '',
        '    @BeforeEach',
        '    void open() {',
        '        entityManager = TestDatabase.open();',
        caller && '        // The caller owns the transaction: the test opens it, and rolls it back at the end',
        caller && '        entityManager.getTransaction().begin();',
        '        uow = new SqlUnitOfWork(entityManager);',
        '    }',
        '',
        '    @AfterEach',
        '    void close() {',
        '        if (entityManager.getTransaction().isActive()) entityManager.getTransaction().rollback();',
        '        entityManager.close();',
        '    }',
      ],
      ...nested,
      '}',
      '',
    )
    files.push({ path: javaPath(pkg, className, true), content })
  }
  return files
}
