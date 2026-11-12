/**
 * The tests of a generated C# project, which are also what the verification runs (xUnit v3): factories that build
 * valid rows (and their parents first), repository tests against a real database created from the mapping, and
 * service tests on the in-memory unit of work (or on the database when the project has no memory repositories).
 * The database is SQLite in memory unless TEST_DATABASE_CONNECTION names another. Mirrors java/tests.ts.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines, type Line } from '../types.ts'
import { csString, CsUsings } from './csharp.ts'
import {
  columnOf,
  commonNamespace,
  errorsNamespace,
  findInfo,
  namespaceOf,
  operationName,
  pathOf,
  query,
  queryName,
  serviceClass,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, updateColumns, updateNamespace, updateType } from './dtos.ts'
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

const newName = (info: TableInfo) => `New${info.entity}`
const addName = (info: TableInfo) => `Add${info.entity}Async`
const testsNs = (context: Context) => `${context.base}.Tests`

/** A value to pass where the column's plain type is asked for. */
const plain = (expression: string, column: ColumnInfo) => (column.optional && column.valueType ? `${expression}!.Value` : expression)

function file(context: Context, name: string, usings: CsUsings, body: (Line | Line[])[]): GeneratedFile {
  const written = usings.write()
  return {
    path: pathOf(testsNs(context), name, true),
    content: lines(written !== '' && [written, ''], `namespace ${testsNs(context)};`, '', ...body, ''),
  }
}

// Factories

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const usings = new CsUsings(testsNs(context)).add(context.base)
  const blocks = makeable.map((info) => {
    usings.add(namespaceOf(context, info, 'entity'))
    const parents: string[] = []
    const fromParents: string[] = []
    const parentColumns = new Set<string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      usings.add(namespaceOf(context, parent, 'entity'))
      parents.push(`        var parent${index} = await ${addName(parent)}(uow, n);`)
      key.columns.forEach((column, position) => {
        parentColumns.add(column)
        fromParents.push(
          `        entity.${columnOf(info, column).prop} = parent${index}.${columnOf(parent, key.references.columns[position]).prop};`,
        )
      })
    })
    const values = info.columns
      .filter((column) => !column.generated && !parentColumns.has(column.column.name))
      .flatMap((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        if (column === info.soft) return column.column.type.kind === 'boolean' ? [`        entity.${column.prop} = false;`] : []
        if (column.column.nullable && isKey) return []
        return [`        entity.${column.prop} = ${sampleValue(column, info.table.checks, context.schema.enums)};`]
      })
    const insert = query(info, 'insert')!
    return [
      `    /// <summary>A valid ${info.entity} that is not stored yet; n makes its unique values differ.</summary>`,
      `    public static ${info.entity} ${newName(info)}(int n)`,
      '    {',
      `        var entity = new ${info.entity}();`,
      ...values,
      '        return entity;',
      '    }',
      '',
      `    /// <summary>A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}.</summary>`,
      `    public static async Task<${info.entity}> ${addName(info)}(IUnitOfWork uow, int n)`,
      '    {',
      ...parents,
      `        var entity = ${newName(info)}(n);`,
      ...fromParents,
      `        return await uow.${info.attr}.${queryName(context, insert)}(entity);`,
      '    }',
    ]
  })
  return file(context, 'Factories', usings, [
    '/// <summary>Rows for the tests: valid values for every column, and the rows they point to.</summary>',
    'internal static class Factories',
    '{',
    ...blocks.flatMap((block, index) => [index > 0 ? '' : null, ...block]),
    '}',
  ])
}

// The test database

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const usings = new CsUsings(testsNs(context)).add(context.base)
  if (sqlite) usings.add('Microsoft.Data.Sqlite', 'Microsoft.EntityFrameworkCore')
  return file(context, 'TestDatabase', usings, [
    sqlite
      ? '/// <summary>The test database: TEST_DATABASE_CONNECTION, or SQLite in memory, created empty from the mapping for every test.</summary>'
      : `/// <summary>The test database: the ${NAMES[database]} database TEST_DATABASE_CONNECTION names, created empty from the mapping for every test.</summary>`,
    'public sealed class TestDatabase : IAsyncDisposable',
    '{',
    '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
    '',
    sqlite && ['    private readonly SqliteConnection? memory;', ''],
    sqlite ? '    private TestDatabase(AppDbContext db, SqliteConnection? memory)' : '    private TestDatabase(AppDbContext db)',
    '    {',
    '        Db = db;',
    sqlite && '        this.memory = memory;',
    '    }',
    '',
    '    public AppDbContext Db { get; }',
    '',
    '    /// <summary>The test database, with every table dropped and created again.</summary>',
    '    public static async Task<TestDatabase> OpenAsync()',
    '    {',
    ...(sqlite
      ? [
          '        SqliteConnection? memory = null;',
          '        DbContextOptions<AppDbContext> options;',
          '        if (Connection is null)',
          '        {',
          '            // An in-memory database lives as long as its connection is open',
          '            memory = new SqliteConnection("Data Source=:memory:");',
          '            memory.Open();',
          '            options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(memory).Options;',
          '        }',
          '        else options = Database.Options(Connection);',
          '        var db = new AppDbContext(options);',
        ]
      : [
          '        // The mapping is written for one kind of database: the tests cannot fall back to SQLite',
          '        if (Connection is null)',
          `            throw new InvalidOperationException("The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_CONNECTION (it is emptied)");`,
          '        var db = new AppDbContext(Database.Options(Connection));',
        ]),
    '        await db.Database.EnsureDeletedAsync();',
    '        await db.Database.EnsureCreatedAsync();',
    sqlite ? '        return new TestDatabase(db, memory);' : '        return new TestDatabase(db);',
    '    }',
    '',
    '    public async ValueTask DisposeAsync()',
    '    {',
    '        await Db.DisposeAsync();',
    sqlite && '        if (memory is not null) await memory.DisposeAsync();',
    '    }',
    '}',
  ])
}

function databaseTestsFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const sql =
    database === 'postgresql'
      ? 'SELECT current_database() AS "Value"'
      : sqlite
        ? 'SELECT sqlite_version() AS "Value"'
        : 'SELECT DATABASE() AS Value'
  return file(context, 'DatabaseTests', new CsUsings(testsNs(context)).add('Microsoft.EntityFrameworkCore', 'Xunit'), [
    '/// <summary>The tests run on the database they were asked to.</summary>',
    'public class DatabaseTests',
    '{',
    '    [Fact]',
    sqlite ? '    public async Task IsSqlite()' : '    public async Task IsTheOneTestDatabaseConnectionNames()',
    '    {',
    '        await using var database = await TestDatabase.OpenAsync();',
    `        var value = await database.Db.Database.SqlQueryRaw<string>(${csString(sql)}).SingleAsync();`,
    sqlite ? '        Assert.StartsWith("3.", value);' : '        Assert.Equal(database.Db.Database.GetDbConnection().Database, value);',
    '    }',
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
  '    [Fact]',
  `    public async Task ${name}()`,
  '    {',
  ...body.flat().map((line) => (typeof line === 'string' ? `        ${line}` : line)),
  '    }',
]

function repositoryTests(context: Context, info: TableInfo): Line[][] {
  const repo = `uow.${info.attr}`
  const keyOf = (variable: string) => info.key.map((column) => plain(`${variable}.${column.prop}`, column)).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const tests: Line[][] = []
  const stored = `var stored = await Factories.${addName(info)}(uow, 1);`
  tests.push(
    test('IsStoredAndReadBack', [
      stored,
      'uow.Db.ChangeTracker.Clear();',
      getByKey && [
        `var found = await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')});`,
        'Assert.NotNull(found);',
        ...info.key.map((column) => `Assert.Equal(stored.${column.prop}, found.${column.prop});`),
      ],
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .map(
          (read) =>
            `Assert.NotNull(await ${repo}.${queryName(context, read)}(${read.columns.map((name) => plain(`stored.${columnOf(info, name).prop}`, columnOf(info, name))).join(', ')}));`,
        ),
      ...info.table.foreignKeys
        .map((key) => query(info, 'listByParent', key.columns))
        .filter((item) => item !== undefined)
        .map((read) => {
          const columns = read.columns.map((name) => columnOf(info, name))
          const assert = `Assert.Single(await ${repo}.${queryName(context, read)}(${columns.map((column) => plain(`stored.${column.prop}`, column)).join(', ')}));`
          const optional = columns.filter((column) => column.optional)
          return optional.length > 0
            ? `if (${optional.map((column) => `stored.${column.prop} is not null`).join(' && ')}) ${assert}`
            : assert
        }),
    ]),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test('ListsRowsByKey', [
        `await Factories.${addName(info)}(uow, 1);`,
        `await Factories.${addName(info)}(uow, 2);`,
        context.settings.paging === 'offset'
          ? [`var page = await ${repo}.${name}(0, 1);`, 'Assert.Equal(2, page.Total);', 'Assert.Single(page.Items);']
          : context.settings.paging === 'cursor'
            ? [
                `var first = await ${repo}.${name}(null, 1);`,
                'Assert.Single(first.Items);',
                'Assert.NotNull(first.Next);',
                `var second = await ${repo}.${name}(first.Next, 1);`,
                'Assert.Single(second.Items);',
                'Assert.Null(second.Next);',
              ]
            : [`Assert.Equal(2, (await ${repo}.${name}()).Count);`],
      ]),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test('StoresTheChanges', [
        stored,
        `stored.${text.prop} = "changed";`,
        `await ${repo}.${queryName(context, update)}(stored);`,
        'uow.Db.ChangeTracker.Clear();',
        `Assert.Equal("changed", (await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}))!.${text.prop});`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test('IsDeleted', [
        stored,
        `await ${repo}.${queryName(context, remove)}(stored);`,
        `Assert.Null(await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}));`,
      ]),
    )
  return tests
}

function serviceTests(context: Context, info: TableInfo, usings: CsUsings): Line[][] {
  const service = serviceClass(info)
  usings.add(namespaceOf(context, info, 'service'))
  const dtos = context.settings.serviceTypes === 'dtos'
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create')
  const get = op('get')
  const update = op('update') && query(info, 'update') && query(info, 'getByKey') ? op('update') : undefined
  const remove = op('delete')
  const keyOf = (variable: string) => info.key.map((column) => plain(`${variable}.${column.prop}`, column)).join(', ')
  // Rows go in through the service (when it creates them) and the parents through the factories
  const parentsFirst: string[] = []
  const overrides: { column: string; value: string }[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    usings.add(namespaceOf(context, parent, 'entity'))
    parentsFirst.push(`var parent${index} = await Factories.${addName(parent)}(uow, n);`)
    key.columns.forEach((column, position) =>
      overrides.push({ column, value: `parent${index}.${columnOf(parent, key.references.columns[position]).prop}` }),
    )
  })
  const start = ['var n = 1;', ...parentsFirst]
  /** A row from the factory with the parents' keys and the given values set */
  const row = (variable: string, n: number, extra: { column: string; value: string }[] = []) => {
    const given = new Set(extra.map((item) => item.column))
    return [
      `var ${variable} = Factories.${newName(info)}(${n});`,
      ...[...overrides.filter((item) => !given.has(item.column)), ...extra].map(
        (item) => `${variable}.${columnOf(info, item.column).prop} = ${item.value};`,
      ),
    ]
  }
  const input = (variable: string) => (dtos ? `CreateOf(${variable})` : variable)
  /** The changes of an update that sets one field, and keeps the others as the row has them */
  const changes = (target: ColumnInfo, value: string, source: string) => {
    usings.add(updateNamespace(context, info))
    const patch = context.settings.updates === 'patch'
    if (patch) usings.add(commonNamespace(context))
    const fields = updateColumns(info).map((column) => {
      if (patch) return column === target ? `Patch<${column.propType}>.Of(${value})` : `Patch<${column.propType}>.Absent`
      return column === target ? value : `${source}.${column.prop}`
    })
    const record = !dtos || context.settings.dtoKind !== 'class'
    return record
      ? `new ${updateType(context, info)}(${fields.join(', ')})`
      : `new ${updateType(context, info)} { ${updateColumns(info)
          .map((column, index) => `${column.prop} = ${fields[index]}`)
          .join(', ')} }`
  }
  const version = (variable: string) => (info.version ? `, ${plain(`${variable}.${info.version.prop}`, info.version)}` : '')
  const tests: Line[][] = []
  const open = [`var service = new ${service}(uow);`]
  if (create) {
    const name = operationName(context, create)
    tests.push(
      test('CreatesAValidRow', [
        ...open,
        ...start,
        ...row('row', 1),
        `var created = await service.${name}(${input('row')});`,
        get && [
          `var found = await service.${operationName(context, get)}(${keyOf('created')});`,
          ...info.key.map((column) => `Assert.Equal(created.${column.prop}, found.${column.prop});`),
        ],
      ]),
    )
    // A missing value can only be told when the property can be null
    const required = info.columns.find(
      (column) => column.required && !column.valueType && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      usings.add(errorsNamespace(context))
      tests.push(
        test('RefusesAMissingValue', [
          ...open,
          ...start,
          ...row('row', 1, [{ column: required.column.name, value: 'null!' }]),
          `var error = await Assert.ThrowsAsync<ValidationFailedException>(() => service.${name}(${input('row')}));`,
          `Assert.Equal(new[] { ${csString(required.column.name)} }, error.Errors.Select(item => item.Field));`,
        ]),
      )
    }
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      usings.add(errorsNamespace(context))
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        test('RefusesARepeatedUniqueValue', [
          ...open,
          ...start,
          ...row('row', 1),
          `var first = await service.${name}(${input('row')});`,
          ...row(
            'again',
            2,
            own.map((column) => ({ column: column.column.name, value: `first.${column.prop}` })),
          ),
          `await Assert.ThrowsAsync<ConflictException>(() => service.${name}(${input('again')}));`,
        ]),
      )
      if (update && own.length === 1 && own.every((column) => !info.key.includes(column) && !column.generated)) {
        tests.push(
          test('KeepsItsOwnUniqueValue', [
            ...open,
            ...start,
            ...row('row', 1),
            `var created = await service.${name}(${input('row')});`,
            `await service.${operationName(context, update)}(${keyOf('created')}, ${changes(own[0], `created.${own[0].prop}`, 'row')}${version('created')});`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      usings.add(errorsNamespace(context))
      const column = columnOf(info, parentKey.columns[0])
      tests.push(
        test('RefusesAMissingParent', [
          ...open,
          ...start,
          ...row('row', 1, [{ column: column.column.name, value: missingValue(column) }]),
          `var error = await Assert.ThrowsAsync<ValidationFailedException>(() => service.${name}(${input('row')}));`,
          `Assert.Contains(${csString(parentKey.columns[0])}, error.Errors.Select(item => item.Field));`,
        ]),
      )
    }
  }
  if (get) {
    usings.add(errorsNamespace(context))
    tests.push(
      test('SaysWhenARowIsMissing', [
        ...open,
        `await Assert.ThrowsAsync<NotFoundException>(() => service.${operationName(context, get)}(${info.key.map((column) => missingValue(column)).join(', ')}));`,
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
        `var created = await service.${operationName(context, create)}(${input('row')});`,
        `var updated = await service.${operationName(context, update)}(${keyOf('created')}, ${changes(text, '"changed"', 'row')}${version('created')});`,
        `Assert.Equal("changed", updated.${text.prop});`,
      ]),
    )
  if (create && remove && get) {
    usings.add(errorsNamespace(context))
    tests.push(
      test('DeletesARow', [
        ...open,
        ...start,
        ...row('row', 1),
        `var created = await service.${operationName(context, create)}(${input('row')});`,
        `await service.${operationName(context, remove)}(${keyOf('created')}${version('created')});`,
        `await Assert.ThrowsAsync<NotFoundException>(() => service.${operationName(context, get)}(${keyOf('created')}));`,
      ]),
    )
  }
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields. */
function createOfHelper(context: Context, info: TableInfo, usings: CsUsings): Line[] {
  usings.add(namespaceOf(context, info, 'dtos'))
  const columns = createColumns(info)
  return [
    '',
    '    /// <summary>The create DTO of a row the factories made.</summary>',
    context.settings.dtoKind === 'class'
      ? `    private static ${createDto(info)} CreateOf(${info.entity} row) => new() { ${columns.map((column) => `${column.prop} = row.${column.prop}`).join(', ')} };`
      : `    private static ${createDto(info)} CreateOf(${info.entity} row) => new(${columns.map((column) => `row.${column.prop}`).join(', ')});`,
  ]
}

/** The fields, setup and teardown of a test class over the test database. */
function databaseMembers(context: Context): Line[] {
  const caller = context.settings.transactions === 'caller'
  return [
    '    private TestDatabase database = null!;',
    '',
    '    /// <summary>The repositories over the test database, opened empty for every test</summary>',
    '    private SqlUnitOfWork uow = null!;',
    '',
    '    public async ValueTask InitializeAsync()',
    '    {',
    '        database = await TestDatabase.OpenAsync();',
    caller && '        // The caller owns the transaction: the test opens it, and it ends with the test',
    caller && '        await database.Db.Database.BeginTransactionAsync();',
    '        uow = new SqlUnitOfWork(database.Db);',
    '    }',
    '',
    '    public async ValueTask DisposeAsync() => await database.DisposeAsync();',
  ]
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [
    {
      path: 'tests/App.Tests/AssemblyInfo.cs',
      content: lines(
        'using Xunit;',
        '',
        '// Every test empties the same database: they run one after another',
        '[assembly: CollectionBehavior(CollectionBehavior.CollectionPerAssembly)]',
        '',
      ),
    },
    testDatabaseFile(context),
    databaseTestsFile(context),
    factoriesFile(context, makeable),
  ]
  const memory = context.settings.memoryRepositories
  for (const info of makeable) {
    const usings = new CsUsings(testsNs(context)).add('Xunit', context.base, namespaceOf(context, info, 'entity'))
    const classes: Line[] = []
    if (tests === 'all' || tests === 'repositories')
      classes.push(
        `/// <summary>The repository of the "${info.name}" table, against the test database.</summary>`,
        `public class ${info.entity}RepositoryTests : IAsyncLifetime`,
        '{',
        ...databaseMembers(context),
        ...repositoryTests(context, info).flat(),
        '}',
      )
    if ((tests === 'all' || tests === 'services') && info.service !== null) {
      const blocks = serviceTests(context, info, usings)
      if (blocks.length > 0) {
        if (classes.length > 0) classes.push('')
        classes.push(
          `/// <summary>The service of the "${info.name}" table, on ${memory ? 'the in-memory repositories' : 'the test database'}.</summary>`,
          memory ? `public class ${serviceClass(info)}Tests` : `public class ${serviceClass(info)}Tests : IAsyncLifetime`,
          '{',
          ...(memory ? ['    private readonly MemoryUnitOfWork uow = new();'] : databaseMembers(context)),
          ...blocks.flat(),
          ...(context.settings.serviceTypes === 'dtos' &&
          query(info, 'insert') &&
          info.operations.some((operation) => operation.kind === 'create')
            ? createOfHelper(context, info, usings)
            : []),
          '}',
        )
      }
    }
    if (classes.length === 0) continue
    files.push(file(context, `${info.entity}Tests`, usings, classes))
  }
  return files
}
