/**
 * The tests of a generated project, which are also what the verification runs (Vitest): factories that build
 * valid rows (and their parents first), repository tests against a real database created from the entities,
 * and service tests on the in-memory unit of work (or on the database when the project has no memory
 * repositories). The database is SQLite in memory unless TEST_DATABASE_URL names another. Mirrors the Python
 * tests (python/common/tests.ts).
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { indent, lines, type Line } from '../../types.ts'
import { missingValue, sampleValue } from '../samples.ts'
import { TsImports } from '../typescript.ts'
import {
  columnOf,
  findInfo,
  moduleOf,
  operationName,
  query,
  queryName,
  serviceClass,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, updateColumns } from './dtos.ts'

type Block = (Line | Line[])[]

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

// test/factories.ts

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const imports = new TsImports('test/factories').type('src/unit-of-work', 'UnitOfWork')
  const blocks = makeable.map((info) => {
    imports.from(moduleOf(context, info, 'entity'), info.entity)
    const parents: string[] = []
    const parentOf = new Map<string, string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      const variable = `parent${index}`
      parents.push(`const ${variable} = await ${addName(parent)}(uow, n)`)
      key.columns.forEach((column, position) =>
        parentOf.set(column, `${variable}.${columnOf(parent, key.references.columns[position]).prop}`),
      )
    })
    // Foreign keys to a required parent are set by add*, from the parent it stores first
    const values = info.columns
      .filter((column) => !column.generated && !parentOf.has(column.column.name))
      .map((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        // A new row is not marked as deleted
        const soft = column === info.soft ? (column.column.type.kind === 'boolean' ? 'false' : 'null') : null
        const value =
          soft ?? (column.column.nullable && isKey ? 'null' : sampleValue(column.column, info.table.checks, context.schema.enums))
        return `${column.prop}: ${value}`
      })
    const insert = query(info, 'insert')!
    const fromParents = [...parentOf.entries()].map(([column, value]) => `${columnOf(info, column).prop}: ${value}`)
    return lines(
      `/** A valid ${info.entity} that is not stored yet; \`n\` makes its unique values differ, \`values\` replace any of them. */`,
      `export function ${newName(info)}(n = 1, values: Partial<${info.entity}> = {}): ${info.entity} {`,
      `  return Object.assign(new ${info.entity}(), { ${values.join(', ')} }, values)`,
      '}',
      '',
      `/** A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}. */`,
      `export async function ${addName(info)}(uow: UnitOfWork, n = 1): Promise<${info.entity}> {`,
      ...parents.map((line) => `  ${line}`),
      `  return uow.${info.attr}.${queryName(context, insert)}(${newName(info)}(n${fromParents.length > 0 ? `, { ${fromParents.join(', ')} }` : ''}))`,
      '}',
    )
  })
  const content = lines(
    '/** Rows for the tests: valid values for every column, and the rows they point to. */',
    imports.write(),
    ...blocks.flatMap((block) => ['', block]),
    '',
  )
  return { path: 'test/factories.ts', content }
}

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

const test = (name: string, body: Block): Line[] => [`it('${name}', async () => {`, indent(lines(...body), 2), '})']

const describeBlock = (name: string, tests: Line[][]): Line[] => [
  '',
  `describe('${name}', () => {`,
  ...tests.flatMap((item, index) => [index > 0 ? '' : null, indent(lines(...item), 2)]),
  '})',
]

// Repository tests

function repositoryTests(context: Context, info: TableInfo, imports: TsImports): Line[][] {
  const repo = `uow.${info.attr}`
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.prop}`).join(', ')
  const open = 'const uow = sqlUow()'
  imports.from('test/factories', addName(info))
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const props = (names: string[]) => names.map((name) => `stored.${columnOf(info, name).prop}`)
  const tests: Line[][] = []
  tests.push(
    test('is stored and read back', [
      open,
      `const stored = await ${addName(info)}(uow, 1)`,
      getByKey && [`const found = await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`, 'expect(found).not.toBeNull()'],
      getByKey && info.key.map((column) => `expect(found!.${column.prop}).toEqual(stored.${column.prop})`),
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .map((read) => `expect(await ${repo}.${queryName(context, read)}(${props(read.columns).join(', ')})).not.toBeNull()`),
      ...info.table.foreignKeys
        .map((key) => query(info, 'listByParent', key.columns))
        .filter((item) => item !== undefined)
        .map(
          (read) =>
            `if (${props(read.columns)
              .map((prop) => `${prop} != null`)
              .join(' && ')}) expect(await ${repo}.${queryName(context, read)}(${props(read.columns).join(', ')})).toHaveLength(1)`,
        ),
    ]),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test('lists rows by key', [
        open,
        `await ${addName(info)}(uow, 1)`,
        `await ${addName(info)}(uow, 2)`,
        context.settings.paging === 'offset'
          ? [`const page = await ${repo}.${name}(0, 1)`, 'expect(page.total).toBe(2)', 'expect(page.items).toHaveLength(1)']
          : context.settings.paging === 'cursor'
            ? [
                `const first = await ${repo}.${name}(null, 1)`,
                'expect(first.items).toHaveLength(1)',
                'expect(first.next).not.toBeNull()',
                `const second = await ${repo}.${name}(first.next, 1)`,
                'expect(second.items).toHaveLength(1)',
                'expect(second.next).toBeNull()',
              ]
            : [`expect(await ${repo}.${name}()).toHaveLength(2)`],
      ]),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test('stores the changes', [
        open,
        `const stored = await ${addName(info)}(uow, 1)`,
        `stored.${text.prop} = 'changed'`,
        `await ${repo}.${queryName(context, update)}(stored)`,
        `const found = await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`,
        `expect(found?.${text.prop}).toBe('changed')`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test('is deleted', [
        open,
        `const stored = await ${addName(info)}(uow, 1)`,
        `await ${repo}.${queryName(context, remove)}(stored)`,
        `expect(await ${repo}.${queryName(context, getByKey)}(${keyOf('stored')})).toBeNull()`,
      ]),
    )
  return tests
}

// Service tests

function serviceTests(context: Context, info: TableInfo, imports: TsImports, memory: boolean): Line[][] {
  const service = serviceClass(info)
  imports.from(moduleOf(context, info, 'service'), service)
  const dtos = context.settings.serviceTypes === 'dtos'
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create')
  const get = op('get')
  const update = op('update')
  const remove = op('delete')
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.prop}`).join(', ')
  const open = [memory ? 'const uow = new MemoryUnitOfWork()' : 'const uow = sqlUow()', `const service = new ${service}(uow)`]
  // Rows go in through the service (when it creates them) and the parents through the factories
  const parentsFirst: string[] = []
  const overrides: string[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    imports.from('test/factories', addName(parent))
    parentsFirst.push(`const parent${index} = await ${addName(parent)}(uow, n)`)
    key.columns.forEach((column, position) =>
      overrides.push(`${columnOf(info, column).prop}: parent${index}.${columnOf(parent, key.references.columns[position]).prop}`),
    )
  })
  const start = [...open, 'const n = 1', ...parentsFirst]
  const factory = (n: number, extra: string[] = []) => {
    // A value given for this test replaces the parent's (a foreign key that is also unique)
    const given = new Set(extra.map((item) => item.slice(0, item.indexOf(':'))))
    const values = [...overrides.filter((item) => !given.has(item.slice(0, item.indexOf(':')))), ...extra]
    return `${newName(info)}(${n}${values.length > 0 ? `, { ${values.join(', ')} }` : ''})`
  }
  const fresh = (n: number, extra: string[] = []) =>
    dtos ? `pick<${createDto(info)}>(${factory(n, extra)}, CREATE_FIELDS)` : factory(n, extra)
  const version = info.version ? `, created.${info.version.prop}` : ''
  const tests: Line[][] = []
  if (create) {
    imports.from('test/factories', newName(info))
    if (dtos) imports.type(moduleOf(context, info, 'dtos'), createDto(info))
    const name = operationName(context, create)
    tests.push(
      test('creates a valid row', [
        ...start,
        `const created = await service.${name}(${fresh(1)})`,
        get && [
          `const found = await service.${operationName(context, get)}(${keyOf('created')})`,
          ...info.key.map((column) => `expect(found.${column.prop}).toEqual(created.${column.prop})`),
        ],
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      imports.from('src/errors', 'ValidationFailedError')
      const missing = dtos
        ? `{ ...${fresh(1)}, ${required.prop}: null } as unknown as ${createDto(info)}`
        : factory(1, [`${required.prop}: null as never`])
      tests.push(
        test('refuses a missing value', [
          ...start,
          `const error: unknown = await service.${name}(${missing}).catch((caught: unknown) => caught)`,
          'expect(error).toBeInstanceOf(ValidationFailedError)',
          `expect((error as ValidationFailedError).errors.map((item) => item.field)).toEqual(['${required.column.name}'])`,
        ]),
      )
    }
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      imports.from('src/errors', 'ConflictError')
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        test('refuses a repeated unique value', [
          ...start,
          `const first = await service.${name}(${fresh(1)})`,
          `await expect(service.${name}(${fresh(
            2,
            own.map((column) => `${column.prop}: first.${column.prop}`),
          )})).rejects.toBeInstanceOf(ConflictError)`,
        ]),
      )
      // A row keeps its own unique value when it changes: the check must not take it for another row
      if (update && own.every((column) => !info.key.includes(column) && !column.generated)) {
        tests.push(
          test('keeps its own unique value', [
            ...start,
            `const created = await service.${name}(${fresh(1)})`,
            `await service.${operationName(context, update)}(${keyOf('created')}, { ${own.map((column) => `${column.prop}: created.${column.prop}`).join(', ')} }${version})`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      imports.from('src/errors', 'ValidationFailedError')
      const column = columnOf(info, parentKey.columns[0])
      const others = overrides.filter((item) => !item.startsWith(`${column.prop}:`))
      const values = [...others, `${column.prop}: ${missingValue(column.column.type)}`]
      const row = `${newName(info)}(1, { ${values.join(', ')} })`
      tests.push(
        test('refuses a missing parent', [
          ...start,
          `const error: unknown = await service.${name}(${dtos ? `pick<${createDto(info)}>(${row}, CREATE_FIELDS)` : row}).catch((caught: unknown) => caught)`,
          'expect(error).toBeInstanceOf(ValidationFailedError)',
          `expect((error as ValidationFailedError).errors.map((item) => item.field)).toContain('${parentKey.columns[0]}')`,
        ]),
      )
    }
  }
  if (get) {
    imports.from('src/errors', 'NotFoundError')
    tests.push(
      test('says when a row is missing', [
        ...open,
        `await expect(service.${operationName(context, get)}(${info.key.map((column) => missingValue(column.column.type)).join(', ')})).rejects.toBeInstanceOf(NotFoundError)`,
      ]),
    )
  }
  const text = changeableText(info)
  if (create && update && text)
    tests.push(
      test('changes a row', [
        ...start,
        `const created = await service.${operationName(context, create)}(${fresh(1)})`,
        `const updated = await service.${operationName(context, update)}(${keyOf('created')}, { ${text.prop}: 'changed' }${version})`,
        `expect(updated.${text.prop}).toBe('changed')`,
      ]),
    )
  if (create && remove && get) {
    imports.from('src/errors', 'NotFoundError')
    tests.push(
      test('deletes a row', [
        ...start,
        `const created = await service.${operationName(context, create)}(${fresh(1)})`,
        `await service.${operationName(context, remove)}(${keyOf('created')}${version})`,
        `await expect(service.${operationName(context, get)}(${keyOf('created')})).rejects.toBeInstanceOf(NotFoundError)`,
      ]),
    )
  }
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields only. */
function pickHelper(info: TableInfo): Line[] {
  return [
    '',
    '/** Fields of the create DTO */',
    `const CREATE_FIELDS = [${createColumns(info)
      .map((column) => `'${column.prop}'`)
      .join(', ')}]`,
    '',
    '/** The values a DTO takes, from a row the factories made. */',
    'function pick<T>(row: object, fields: readonly string[]): T {',
    '  return Object.fromEntries(Object.entries(row).filter(([name]) => fields.includes(name))) as T',
    '}',
  ]
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [...context.orm.testDatabase(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
  for (const info of makeable) {
    const module = `test/${info.file}.test`
    const imports = new TsImports(module).from('vitest', 'describe', 'expect', 'it')
    const blocks: Line[] = []
    let database = false
    if (tests === 'all' || tests === 'repositories') {
      blocks.push(...describeBlock(`${info.name} repository`, repositoryTests(context, info, imports)))
      database = true
    }
    const withService = (tests === 'all' || tests === 'services') && info.service !== null
    if (withService) {
      if (memory) imports.from('src/unit-of-work', 'MemoryUnitOfWork')
      else database = true
      const serviceBlocks = serviceTests(context, info, imports, memory)
      if (serviceBlocks.length > 0) blocks.push(...describeBlock(serviceClass(info), serviceBlocks))
      if (
        context.settings.serviceTypes === 'dtos' &&
        query(info, 'insert') &&
        info.operations.some((operation) => operation.kind === 'create')
      )
        blocks.push(...pickHelper(info))
    }
    if (blocks.length === 0) continue
    if (database) imports.from('test/database', 'useTestDatabase')
    const content = lines(
      `/** Tests of the "${info.name}" table. */`,
      imports.write(),
      database && ['', '/** The repositories over the test database, opened empty for every test */', 'const sqlUow = useTestDatabase()'],
      ...blocks,
      '',
    )
    files.push({ path: `${module}.ts`, content })
  }
  return files
}
