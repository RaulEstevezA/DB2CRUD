/**
 * The tests of a generated Swift package, which are also what the verification runs (swift-testing): factories that
 * build valid rows (and their parents first), repository tests against a real database created with Fluent's schema
 * builder, and service tests on the in-memory unit of work (or on the database when the project has no memory
 * repositories). Every test is in one serialized suite, `DataTests`: they all empty the same database. The database is
 * SQLite in memory unless TEST_DATABASE_URL names another. Mirrors kotlin/tests.ts.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { DbColumn } from '../../schema/types.ts'
import {
  columnOf,
  findInfo,
  operationName,
  query,
  queryName,
  serviceType,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, updateColumns, updateType } from './dtos.ts'
import { imports, swString } from './swift.ts'
import { driverOf } from './support.ts'
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
const ind = (items: string[], spaces = 4) => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
const testPath = (context: Context, name: string) => `Tests/${context.module}Tests/${name}.swift`
/** The imports of a test file. Testing has types of its own (Tag, Test, Issue…): the factories, which need none of them, leave it out. */
const header = (context: Context, testing: boolean, ...modules: string[]) =>
  [imports('Foundation', ...(testing ? ['Testing'] : []), ...modules), `@testable import ${context.module}`].join('\n')

/** A variable nobody uses is a warning, and a warning fails the build: a parent made for a column the test then sets itself is not made. */
function usedLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const parent = /^let (parent\d+) = /.exec(line.trim())?.[1]
    return !parent || lines.some((other) => other !== line && other.includes(`${parent}.`))
  })
}

// Factories

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const blocks = makeable.map((info) => {
    const parents: string[] = []
    const fromParents: string[] = []
    const parentColumns = new Set<string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      parents.push(`let parent${index} = try await ${addName(parent)}(uow, n)`)
      key.columns.forEach((column, position) => {
        parentColumns.add(column)
        fromParents.push(
          `entity.${columnOf(info, column).prop} = parent${index}.${columnOf(parent, key.references.columns[position]).prop}`,
        )
      })
    })
    const values = info.columns
      .filter((column) => !column.generated && !parentColumns.has(column.column.name))
      .flatMap((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        if (column === info.soft) return column.column.type.kind === 'boolean' ? [`${column.key}: false`] : []
        if (column.column.nullable && isKey) return []
        return [`${column.key}: ${sampleValue(column, info.table.checks, context.schema.enums)}`]
      })
    const insert = query(info, 'insert')!
    return [
      `/// A valid ${info.entity} that is not stored yet; n makes its unique values differ.`,
      `static func ${newName(info)}(_ n: Int) -> ${info.entity} {`,
      `    ${info.entity}(${values.join(', ')})`,
      '}',
      '',
      `/// A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}.`,
      '@discardableResult',
      `static func ${addName(info)}(_ uow: any UnitOfWork, _ n: Int) async throws -> ${info.entity} {`,
      ...ind(parents),
      `    ${fromParents.length > 0 ? 'var' : 'let'} entity = ${newName(info)}(n)`,
      ...ind(fromParents),
      `    return try await uow.${info.attr}.${queryName(context, insert)}(entity)`,
      '}',
    ]
  })
  return {
    path: testPath(context, 'Factories'),
    content: [
      header(context, false),
      '',
      '/// Rows for the tests: valid values for every column, and the rows they point to.',
      'enum Factories {',
      ...blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...ind(block)]),
      '}',
      '',
    ].join('\n'),
  }
}

// The test database

const NAMES: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

/** The tables in the order they can be created: the rows they point to first. */
function creationOrder(tables: TableInfo[]): TableInfo[] {
  const order: TableInfo[] = []
  const visit = (info: TableInfo, path: Set<string>) => {
    if (order.includes(info) || path.has(info.name)) return
    path.add(info.name)
    for (const key of info.table.foreignKeys) {
      const parent = tables.find((item) => item.name === key.references.table)
      if (parent && parent !== info) visit(parent, path)
    }
    order.push(info)
  }
  for (const info of tables) visit(info, new Set())
  return order
}

const sqlQuote = (text: string) => `'${text.replace(/'/g, "''")}'`

/** The data type of a column in Fluent's schema builder, as the database has it. */
function dataType(context: Context, column: DbColumn): string {
  const database = context.settings.database
  const type = column.type
  const raw = (sql: string) => `.sql(unsafeRaw: ${swString(sql)})`
  if (type.kind === 'enum' && database !== 'sqlite') {
    const item = context.schema.enums.find((candidate) => candidate.name === type.name)
    if (item?.storage === 'native')
      return database === 'postgresql' ? raw(`"${item.name}"`) : raw(`ENUM(${item.values.map(sqlQuote).join(', ')})`)
  }
  switch (type.kind) {
    case 'integer':
      return type.bits === 16 ? '.int16' : type.bits === 64 ? '.int64' : '.int32'
    case 'decimal':
      return raw(`DECIMAL(${type.precision ?? 10}, ${type.scale ?? 0})`)
    case 'float':
      return type.bits === 32 ? '.float' : '.double'
    case 'boolean':
      return '.bool'
    case 'text':
      return type.length === undefined ? '.string' : raw(`${type.fixed ? 'CHAR' : 'VARCHAR'}(${type.length})`)
    case 'enum': {
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      return raw(`VARCHAR(${Math.max(1, ...values.map((value) => value.length))})`)
    }
    case 'date':
      return '.date'
    case 'time':
      return '.time'
    case 'datetime':
      return type.timezone && database === 'postgresql' ? raw('TIMESTAMPTZ') : '.datetime'
    case 'uuid':
      return '.uuid'
    case 'binary':
      return '.data'
    default:
      return '.string'
  }
}

/** The constraints of a column in Fluent's schema builder: its key, null, its default. */
function constraints(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const db = column.column
  const result: string[] = []
  const single = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  if (single) result.push(`.identifier(auto: ${db.generated === 'identity' ? 'true' : 'false'})`)
  else if (!db.nullable) result.push('.required')
  const raw = (sql: string) => result.push(`.sql(unsafeRaw: ${swString(sql)})`)
  if (db.generated === 'now' || db.generated === 'onUpdateNow')
    // Fluent writes a datetime as DATETIME(6) on MySQL, whose default must have the same precision
    raw(
      db.type.kind === 'date'
        ? 'DEFAULT CURRENT_DATE'
        : ['mysql', 'mariadb'].includes(context.settings.database) && dataType(context, db) === '.datetime'
          ? 'DEFAULT CURRENT_TIMESTAMP(6)'
          : 'DEFAULT CURRENT_TIMESTAMP',
    )
  else if (typeof db.generated === 'object') raw(`GENERATED ALWAYS AS (${db.generated.computed}) STORED`)
  else if (db.default?.kind === 'literal' && db.default.value !== null) {
    const value = db.default.value
    raw(`DEFAULT ${typeof value === 'string' ? sqlQuote(value) : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)}`)
  } else if (db.default?.kind === 'expression') raw(`DEFAULT ${db.default.sql}`)
  return result
}

const ACTIONS: Record<string, string> = {
  cascade: '.cascade',
  'set null': '.setNull',
  'set default': '.setDefault',
  restrict: '.restrict',
  'no action': '.noAction',
}

/** The schema builder of a table, as the database has it. */
function createTable(context: Context, info: TableInfo): string[] {
  const { table } = info
  const space = table.schema && context.settings.database === 'postgresql' ? `, space: ${swString(table.schema)}` : ''
  const lines = [`try await db.schema(${swString(table.name)}${space})`]
  for (const column of info.columns)
    lines.push(
      `    .field(${[swString(column.column.name), dataType(context, column.column), ...constraints(context, info, column)].join(', ')})`,
    )
  if (table.primaryKey && table.primaryKey.length > 1)
    lines.push(`    .compositeIdentifier(over: ${table.primaryKey.map(swString).join(', ')})`)
  for (const unique of table.uniques)
    lines.push(`    .unique(on: ${unique.columns.map(swString).join(', ')}${unique.name ? `, name: ${swString(unique.name)}` : ''})`)
  for (const key of table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent || !parent.writesEntity) continue
    const parentSpace =
      parent.table.schema && context.settings.database === 'postgresql' ? `, inSpace: ${swString(parent.table.schema)}` : ''
    const many = key.columns.length > 1
    const fields = (names: string[]) => (many ? `[${names.map(swString).join(', ')}]` : swString(names[0]))
    lines.push(
      `    .foreignKey(${fields(key.columns)}, references: ${swString(parent.name)}${parentSpace}, ${fields(key.references.columns)}, onDelete: ${ACTIONS[key.onDelete ?? 'no action']}${key.name ? `, name: ${swString(key.name)}` : ''})`,
    )
  }
  lines.push('    .create()')
  return lines
}

function testDatabaseFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const postgres = database === 'postgresql'
  const tables = context.tables.filter((info) => info.writesEntity)
  const quote = (name: string) => (database === 'mysql' || database === 'mariadb' ? `\`${name}\`` : `"${name}"`)
  const qualifiedName = (info: TableInfo) =>
    info.table.schema && postgres ? `${quote(info.table.schema)}.${quote(info.name)}` : quote(info.name)
  const schemas = postgres ? [...new Set(context.tables.map((info) => info.table.schema).filter((name): name is string => !!name))] : []
  const enums = postgres
    ? context.schema.enums.filter(
        (item) =>
          item.storage === 'native' &&
          context.tables.some((info) =>
            info.columns.some((column) => column.column.type.kind === 'enum' && column.column.type.name === item.name),
          ),
      )
    : []
  const run = (sql: string) => `try await sql.raw(${swString(sql)}).run()`
  const order = creationOrder(tables)
  const check = postgres ? 'SELECT current_database() AS value' : sqlite ? 'SELECT sqlite_version() AS value' : 'SELECT DATABASE() AS value'
  return {
    path: testPath(context, 'TestDatabase'),
    content: [
      header(context, true, 'FluentKit', 'FluentSQL', ...(sqlite ? [driverOf(context).module] : [])),
      '',
      '/// Every test is in this suite, one after another: they all empty the same database.',
      '@Suite(.serialized) struct DataTests {}',
      '',
      sqlite
        ? '/// The test database: TEST_DATABASE_URL, or SQLite in memory, created again before every test.'
        : `/// The test database: the ${NAMES[database]} database TEST_DATABASE_URL names, created again before every test.`,
      'enum TestDatabase {',
      '    /// Runs body with the repositories over the test database, with every table dropped and created again first.',
      '    static func with(_ body: (SqlUnitOfWork) async throws -> Void) async throws {',
      ...(sqlite
        ? [
            '        let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"]',
            '        let app = if let url { AppDatabase(url: url) } else { AppDatabase(configuration: .sqlite(.memory)) }',
          ]
        : [
            '        // The tables are written for one kind of database: the tests cannot fall back to SQLite',
            `        let url = try #require(ProcessInfo.processInfo.environment["TEST_DATABASE_URL"], ${swString(`The database tests need a disposable ${NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)`)})`,
            '        let app = try AppDatabase(url: url)',
          ]),
      '        do {',
      '            try await recreate(app.database)',
      '            try await body(SqlUnitOfWork(db: app.database))',
      '        } catch {',
      '            await app.shutdown()',
      '            throw error',
      '        }',
      '        await app.shutdown()',
      '    }',
      '',
      '    /// Drops every table, the rows that point to others first, and creates them again as the database has them.',
      '    private static func recreate(_ db: any Database) async throws {',
      '        let sql = db as! any SQLDatabase',
      ...ind(
        [
          ...schemas.map((name) => run(`DROP SCHEMA IF EXISTS ${quote(name)} CASCADE`)),
          ...[...order].reverse().map((info) => run(`DROP TABLE IF EXISTS ${qualifiedName(info)}${postgres ? ' CASCADE' : ''}`)),
          ...enums.flatMap((item) => [
            run(`DROP TYPE IF EXISTS ${quote(item.name)} CASCADE`),
            run(`CREATE TYPE ${quote(item.name)} AS ENUM (${item.values.map(sqlQuote).join(', ')})`),
          ]),
          ...schemas.map((name) => run(`CREATE SCHEMA ${quote(name)}`)),
          ...order.flatMap((info) => createTable(context, info)),
        ],
        8,
      ),
      '    }',
      '}',
      '',
      '/// The DomainError work throws, or nil when it throws none.',
      'func refusal<T>(_ work: () async throws -> T) async -> DomainError? {',
      '    do {',
      '        _ = try await work()',
      '        return nil',
      '    } catch let error as DomainError {',
      '        return error',
      '    } catch {',
      '        return nil',
      '    }',
      '}',
      '',
      'func isConflict(_ error: DomainError?) -> Bool {',
      '    if case .some(.conflict) = error { true } else { false }',
      '}',
      '',
      'func isNotFound(_ error: DomainError?) -> Bool {',
      '    if case .some(.notFound) = error { true } else { false }',
      '}',
      '',
      'extension DataTests {',
      '    /// The tests run on the database they were asked to.',
      '    @Suite struct DatabaseTests {',
      '        @Test func isTheTestDatabase() async throws {',
      '            try await TestDatabase.with { uow in',
      `                let rows = try await (uow.db as! any SQLDatabase).raw(${swString(check)}).all()`,
      '                let value = try rows[0].decode(column: "value", as: String.self)',
      sqlite
        ? '                #expect(value.hasPrefix("3."))'
        : '                let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"] ?? ""\n                #expect(url.split(separator: "/").last?.split(separator: "?").first.map(String.init) == value)',
      '            }',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
  }
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

/** A test: its body on the test database, or as it is. */
function test(name: string, body: (string | string[] | false | null | undefined)[], onDatabase: boolean): string[] {
  const lines = usedLines(body.flat().filter((line): line is string => typeof line === 'string'))
  return [
    '',
    `@Test func ${name}() async throws {`,
    ...(onDatabase ? ['    try await TestDatabase.with { uow in', ...ind(lines, 8), '    }'] : ind(lines)),
    '}',
  ]
}

/** An assertion on a stored row's values, made only when those that may be nil have one. */
function whenSet(columns: ColumnInfo[], assertion: string): string[] {
  const optional = columns.filter((column) => column.column.nullable)
  if (optional.length === 0) return [assertion]
  return [`if ${optional.map((column) => `stored.${column.prop} != nil`).join(', ')} {`, `    ${assertion}`, '}']
}

function repositoryTests(context: Context, info: TableInfo): string[][] {
  const repo = `uow.${info.attr}`
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.prop}!`).join(', ')
  const args = (columns: ColumnInfo[]) => columns.map((column) => `stored.${column.prop}!`).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const tests: string[][] = []
  const checks = [
    ...info.table.uniques
      .map((unique) => query(info, 'findByUnique', unique.columns))
      .filter((item) => item !== undefined)
      .flatMap((read) => {
        const columns = read.columns.map((name) => columnOf(info, name))
        return whenSet(columns, `#expect(try await ${repo}.${queryName(context, read)}(${args(columns)}) != nil)`)
      }),
    ...info.table.foreignKeys
      .map((key) => query(info, 'listByParent', key.columns))
      .filter((item) => item !== undefined)
      .flatMap((read) => {
        const columns = read.columns.map((name) => columnOf(info, name))
        return whenSet(columns, `#expect(try await ${repo}.${queryName(context, read)}(${args(columns)}).count == 1)`)
      }),
  ]
  const usesStored = getByKey !== undefined || checks.length > 0
  tests.push(
    test(
      'isStoredAndReadBack',
      [
        `${usesStored ? 'let stored =' : '_ ='} try await Factories.${addName(info)}(uow, 1)`,
        getByKey && [
          `let row = try await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`,
          'let found = try #require(row)',
          ...info.key.map((column) => `#expect(found.${column.prop} == stored.${column.prop})`),
        ],
        ...checks,
      ],
      true,
    ),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test(
        'listsRowsByKey',
        [
          `try await Factories.${addName(info)}(uow, 1)`,
          `try await Factories.${addName(info)}(uow, 2)`,
          context.settings.paging === 'offset'
            ? [`let page = try await ${repo}.${name}(offset: 0, limit: 1)`, '#expect(page.total == 2)', '#expect(page.items.count == 1)']
            : context.settings.paging === 'cursor'
              ? [
                  `let first = try await ${repo}.${name}(after: nil, limit: 1)`,
                  '#expect(first.items.count == 1)',
                  '#expect(first.next != nil)',
                  `let second = try await ${repo}.${name}(after: first.next, limit: 1)`,
                  '#expect(second.items.count == 1)',
                  '#expect(second.next == nil)',
                ]
              : [`#expect(try await ${repo}.${name}().count == 2)`],
        ],
        true,
      ),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test(
        'storesTheChanges',
        [
          `var stored = try await Factories.${addName(info)}(uow, 1)`,
          `stored.${text.prop} = "changed"`,
          `try await ${repo}.${queryName(context, update)}(stored)`,
          `let found = try await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`,
          `#expect(found?.${text.prop} == "changed")`,
        ],
        true,
      ),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test(
        'isDeleted',
        [
          `let stored = try await Factories.${addName(info)}(uow, 1)`,
          `try await ${repo}.${queryName(context, remove)}(stored)`,
          `#expect(try await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}) == nil)`,
        ],
        true,
      ),
    )
  return tests
}

function serviceTests(context: Context, info: TableInfo): string[][] {
  const service = serviceType(info)
  const dtos = context.settings.serviceTypes === 'dtos'
  const memory = context.settings.memoryRepositories
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create') && query(info, 'insert') ? op('create') : undefined
  const get = op('get') && query(info, 'getByKey') ? op('get') : undefined
  const update = op('update') && query(info, 'update') && query(info, 'getByKey') ? op('update') : undefined
  const remove = op('delete')
  const deletes =
    remove && query(info, 'getByKey') && ((info.soft && query(info, 'update')) || (!info.soft && query(info, 'delete')))
      ? remove
      : undefined
  /** A column of what the service returns, known to be set */
  const member = (variable: string, column: ColumnInfo) =>
    dtos && !column.column.nullable ? `${variable}.${column.prop}` : `${variable}.${column.prop}!`
  const keyOf = (variable: string) => info.key.map((column) => member(variable, column)).join(', ')
  // Rows go in through the service (when it creates them) and the parents through the factories, numbered 100: the
  // rows of the test never take that number, and a parent may be a row of the same table
  const parentsFirst: string[] = []
  const overrides: { column: string; value: string }[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    parentsFirst.push(`let parent${index} = try await Factories.${addName(parent)}(uow, 100)`)
    key.columns.forEach((column, position) =>
      overrides.push({ column, value: `parent${index}.${columnOf(parent, key.references.columns[position]).prop}` }),
    )
  })
  const row = (variable: string, n: number, extra: { column: string; value: string }[] = []) => {
    const given = new Set(extra.map((item) => item.column))
    const assignments = [...overrides.filter((item) => !given.has(item.column)), ...extra]
    return [
      `${assignments.length > 0 ? 'var' : 'let'} ${variable} = Factories.${newName(info)}(${n})`,
      ...assignments.map((item) => `${variable}.${columnOf(info, item.column).prop} = ${item.value}`),
    ]
  }
  const input = (variable: string) => (dtos ? `createOf(${variable})` : variable)
  /** The changes of an update that sets one field, and keeps the others as the row has them */
  const changes = (target: ColumnInfo, value: { option: string; stored: string }, source: string) => {
    const type = updateType(context, info)
    const mode = context.settings.updates
    if (mode === 'patch') return `${type}(${target.key}: .set(${value.option}))`
    if (mode === 'optional') return `${type}(${target.key}: .some(${value.option}))`
    const fields = updateColumns(info).map(
      (column) =>
        `${column.key}: ${column === target ? value.stored : column.column.nullable ? `${source}.${column.prop}` : `${source}.${column.prop}!`}`,
    )
    return `${type}(${fields.join(', ')})`
  }
  const version = (variable: string) => (info.version ? `, version: ${member(variable, info.version)}` : '')
  const tests: string[][] = []
  const open = [`let service = ${service}(unitOfWork: uow)`]
  const make = (name: string, body: (string | string[])[]) =>
    test(name, memory ? ['let uow = MemoryUnitOfWork()', ...body.flat()] : body.flat(), !memory)
  if (create) {
    const name = operationName(context, create)
    tests.push(
      make('createsAValidRow', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        get
          ? [
              `let created = try await service.${name}(${input('row')})`,
              `let found = try await service.${operationName(context, get)}(${keyOf('created')})`,
              ...info.key.map((column) => `#expect(created.${column.prop} == found.${column.prop})`),
            ]
          : dtos
            ? [`try await service.${name}(${input('row')})`]
            : [
                `let created = try await service.${name}(${input('row')})`,
                ...info.key.map((column) => `#expect(created.${column.prop} != nil)`),
              ],
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required)
      tests.push(
        make('refusesAMissingValue', [
          ...open,
          ...parentsFirst,
          ...row('row', 1, [{ column: required.column.name, value: 'nil' }]),
          `let error = await refusal { try await service.${name}(${input('row')}) }`,
          `#expect(error?.invalidFields == [${swString(required.column.name)}])`,
        ]),
      )
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        make('refusesARepeatedUniqueValue', [
          ...open,
          ...parentsFirst,
          ...row('row', 1),
          `let first = try await service.${name}(${input('row')})`,
          ...row(
            'again',
            2,
            own.map((column) => ({ column: column.column.name, value: `first.${column.prop}` })),
          ),
          `#expect(isConflict(await refusal { try await service.${name}(${input('again')}) }))`,
        ]),
      )
      if (update && own.length === 1 && own.every((column) => !info.key.includes(column) && !column.generated)) {
        const target = own[0]
        const kept = {
          option: `created.${target.prop}`,
          stored: target.column.nullable ? `created.${target.prop}` : member('created', target),
        }
        tests.push(
          make('keepsItsOwnUniqueValue', [
            ...open,
            ...parentsFirst,
            ...row('row', 1),
            `let created = try await service.${name}(${input('row')})`,
            `let updated = try await service.${operationName(context, update)}(${keyOf('created')}, ${changes(target, kept, 'row')}${version('created')})`,
            `#expect(created.${target.prop} == updated.${target.prop})`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      const column = columnOf(info, parentKey.columns[0])
      tests.push(
        make('refusesAMissingParent', [
          ...open,
          ...parentsFirst,
          ...row('row', 1, [{ column: column.column.name, value: missingValue(column) }]),
          `let error = await refusal { try await service.${name}(${input('row')}) }`,
          `#expect(error?.invalidFields.contains(${swString(parentKey.columns[0])}) == true)`,
        ]),
      )
    }
  }
  if (get)
    tests.push(
      make('saysWhenARowIsMissing', [
        ...open,
        `#expect(isNotFound(await refusal { try await service.${operationName(context, get)}(${info.key.map(missingValue).join(', ')}) }))`,
      ]),
    )
  const text = changeableText(info)
  if (create && update && text)
    tests.push(
      make('changesARow', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `let created = try await service.${operationName(context, create)}(${input('row')})`,
        `let updated = try await service.${operationName(context, update)}(${keyOf('created')}, ${changes(text, { option: '"changed"', stored: '"changed"' }, 'row')}${version('created')})`,
        `#expect(updated.${text.prop} == "changed")`,
      ]),
    )
  if (create && deletes && get)
    tests.push(
      make('deletesARow', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `let created = try await service.${operationName(context, create)}(${input('row')})`,
        `try await service.${operationName(context, deletes)}(${keyOf('created')}${version('created')})`,
        `#expect(isNotFound(await refusal { try await service.${operationName(context, get)}(${keyOf('created')}) }))`,
      ]),
    )
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields. */
function createOfHelper(context: Context, info: TableInfo): string[] {
  return [
    '',
    '/// The create DTO of a row the factories made.',
    // The entity by its module: a test file imports Testing, whose names may be the same
    `fileprivate func createOf(_ row: ${context.module}.${info.entity}) -> ${createDto(info)} {`,
    `    ${createDto(info)}(${createColumns(info)
      .map((column) => `${column.key}: row.${column.prop}`)
      .join(', ')})`,
    '}',
  ]
}

/** A suite of tests, in the serialized suite of the package. */
function suiteFile(context: Context, name: string, doc: string, blocks: string[][], after: string[] = []): GeneratedFile {
  return {
    path: testPath(context, name),
    content: [
      header(context, true),
      '',
      'extension DataTests {',
      `    /// ${doc}`,
      `    @Suite struct ${name} {`,
      ...ind(blocks.flat(), 8),
      '    }',
      '}',
      ...after,
      '',
    ].join('\n'),
  }
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [testDatabaseFile(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
  for (const info of makeable) {
    if (tests === 'all' || tests === 'repositories')
      files.push(
        suiteFile(
          context,
          `${info.entity}RepositoryTests`,
          `The repository of the "${info.name}" table, against the test database.`,
          repositoryTests(context, info),
        ),
      )
    if ((tests === 'all' || tests === 'services') && info.service !== null) {
      const blocks = serviceTests(context, info)
      if (blocks.length === 0) continue
      const helper =
        context.settings.serviceTypes === 'dtos' && blocks.flat().some((line) => line.includes('createOf('))
          ? createOfHelper(context, info)
          : []
      files.push(
        suiteFile(
          context,
          `${serviceType(info)}Tests`,
          `The service of the "${info.name}" table, on ${memory ? 'the in-memory repositories' : 'the test database'}.`,
          blocks,
          helper,
        ),
      )
    }
  }
  return files
}
