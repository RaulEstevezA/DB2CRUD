/**
 * The tests of a generated project, which are also what the verification runs: factories that build valid
 * rows (and their parents first), repository tests against a real database created from the entities, and
 * service tests on the in-memory unit of work (or on the database when the project has no memory
 * repositories). The database is SQLite in a temporary file unless TEST_DATABASE_URL names another.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { indent, lines, type Line } from '../../types.ts'
import { Imports } from '../python.ts'
import { missingValue, sampleValue } from '../samples.ts'
import {
  aw,
  findInfo,
  moduleOf,
  operationName,
  query,
  queryName,
  serviceClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { writesEntities } from './database.ts'
import { createDto, updateColumns, updateDto } from './dtos.ts'

type Block = (Line | Line[])[]

/** Tables whose rows the tests can make: they can be inserted, and so can the parents they need. */
function canMake(context: Context, info: TableInfo, seen = new Set<string>()): boolean {
  if (seen.has(info.name) || !query(info, 'insert')) return false
  const next = new Set(seen).add(info.name)
  return info.table.foreignKeys.every((key) => {
    const nullable = key.columns.every((name) => info.columns.find((column) => column.column.name === name)!.column.nullable)
    if (nullable) return true
    const parent = findInfo(context, key.references.table)
    return parent !== undefined && canMake(context, parent, next)
  })
}

/** Columns the factory sets: everything the database does not fill, foreign keys from the parents. */
function factoryColumns(info: TableInfo): ColumnInfo[] {
  return info.columns.filter((column) => !column.generated)
}

const def = (context: Context) => (context.async ? 'async def' : 'def')

// tests/factories.py

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const imports = new Imports().from('app.unit_of_work', 'UnitOfWork')
  const a = aw(context)
  const blocks = makeable.map((info) => {
    imports.from(moduleOf(context, info, 'entity'), info.entity)
    const parents: Line[] = []
    const parentOf = new Map<string, string>()
    info.table.foreignKeys.forEach((key, index) => {
      const nullable = key.columns.every((name) => info.columns.find((column) => column.column.name === name)!.column.nullable)
      const parent = findInfo(context, key.references.table)
      if (nullable || !parent) return
      const variable = `parent_${index}`
      parents.push(`${variable} = ${a}add_${parent.module}(uow, n)`)
      key.columns.forEach((column, position) => {
        const target = parent.columns.find((item) => item.column.name === key.references.columns[position])!
        parentOf.set(column, `${variable}.${target.attr}`)
      })
    })
    // Foreign keys to a required parent are set by add_*, from the parent it stores first
    const values = factoryColumns(info)
      .filter((column) => !parentOf.has(column.column.name))
      .map((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        // A new row is not marked as deleted
        const soft = column === info.soft ? (column.column.type.kind === 'boolean' ? 'False' : 'None') : null
        const value =
          soft ?? (column.column.nullable && isKey ? 'None' : sampleValue(column.column, info.table.checks, context.schema.enums, imports))
        return `"${column.attr}": ${value}`
      })
    const insert = query(info, 'insert')!
    const fromParents = [...parentOf.entries()].map(
      ([column, value]) => `${info.columns.find((item) => item.column.name === column)!.attr}=${value}`,
    )
    return lines(
      `def new_${info.module}(n: int = 1, **values: Any) -> ${info.entity}:`,
      `    """A valid ${info.entity} that is not stored yet; \`n\` makes its unique values differ, \`values\` replace any of them."""`,
      `    defaults: dict[str, Any] = {${values.join(', ')}}`,
      `    return ${info.entity}(**(defaults | values))`,
      '',
      '',
      `${def(context)} add_${info.module}(uow: UnitOfWork, n: int = 1) -> ${info.entity}:`,
      `    """A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}."""`,
      ...parents.map((line) => `    ${line}`),
      `    return ${a}uow.${info.attr}.${queryName(context, insert)}(new_${info.module}(${['n', ...fromParents].join(', ')}))`,
    )
  })
  imports.from('typing', 'Any')
  const content = lines(
    '"""Rows for the tests: valid values for every column, and the rows they point to."""',
    '',
    imports.write('app'),
    ...blocks.flatMap((block) => ['', '', block]),
    '',
  )
  return { path: 'tests/factories.py', content }
}

// tests/conftest.py

function conftestFile(context: Context): GeneratedFile {
  const imports = new Imports().module('os').module('pytest')
  imports.from('app.db', 'Base', 'create_db_engine', 'create_session_factory').from('app.unit_of_work', 'SqlUnitOfWork')
  if (context.settings.memoryRepositories) imports.from('app.unit_of_work', 'MemoryUnitOfWork')
  for (const info of context.tables) if (info.writesEntity) imports.from(moduleOf(context, info, 'entity'), info.entity)
  const async = context.async
  if (async) imports.module('pytest_asyncio').from('collections.abc', 'AsyncIterator')
  else imports.from('collections.abc', 'Iterator')
  const fixture = async ? '@pytest_asyncio.fixture' : '@pytest.fixture'
  const content = lines(
    '"""Fixtures of the tests: a database created from the entities, and the units of work."""',
    '',
    imports.write('app'),
    '',
    '# Every entity is imported above, so the metadata knows every table',
    '',
    '',
    fixture,
    async ? 'async def engine(tmp_path):  # type: ignore[no-untyped-def]' : 'def engine(tmp_path):  # type: ignore[no-untyped-def]',
    '    """The test database, empty: TEST_DATABASE_URL, or SQLite in a temporary file."""',
    '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
    '    engine = create_db_engine(url)',
    async
      ? [
          '    async with engine.begin() as connection:',
          '        await connection.run_sync(Base.metadata.drop_all)',
          '        await connection.run_sync(Base.metadata.create_all)',
          '    yield engine',
          '    async with engine.begin() as connection:',
          '        await connection.run_sync(Base.metadata.drop_all)',
          '    await engine.dispose()',
        ]
      : [
          '    Base.metadata.drop_all(engine)',
          '    Base.metadata.create_all(engine)',
          '    yield engine',
          '    Base.metadata.drop_all(engine)',
          '    engine.dispose()',
        ],
    '',
    '',
    fixture,
    async
      ? 'async def sql_uow(engine) -> AsyncIterator[SqlUnitOfWork]:  # type: ignore[no-untyped-def]'
      : 'def sql_uow(engine) -> Iterator[SqlUnitOfWork]:  # type: ignore[no-untyped-def]',
    '    """The repositories over a session of the test database."""',
    async
      ? ['    async with create_session_factory(engine)() as session:', '        yield SqlUnitOfWork(session)']
      : ['    with create_session_factory(engine)() as session:', '        yield SqlUnitOfWork(session)'],
    context.settings.memoryRepositories && [
      '',
      '',
      '@pytest.fixture',
      'def memory_uow() -> MemoryUnitOfWork:',
      '    """The in-memory repositories."""',
      '    return MemoryUnitOfWork()',
    ],
    '',
  )
  return { path: 'tests/conftest.py', content }
}

// Repository tests

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

function repositoryTests(context: Context, info: TableInfo, imports: Imports): Block {
  const a = aw(context)
  const repo = `sql_uow.${info.attr}`
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.attr}`).join(', ')
  const test = (name: string, body: Block) => [
    '',
    '',
    `${def(context)} test_${info.module}_${name}(sql_uow: SqlUnitOfWork) -> None:`,
    indent(lines(...body)),
  ]
  imports.from('tests.factories', `add_${info.module}`)
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const blocks: Block = []
  blocks.push(
    ...test('is_stored_and_read_back', [
      `stored = ${a}add_${info.module}(sql_uow, 1)`,
      getByKey && `found = ${a}${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`,
      getByKey && 'assert found is not None',
      getByKey && info.key.map((column) => `assert found.${column.attr} == stored.${column.attr}`),
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .map(
          (read) =>
            `assert ${a}${repo}.${queryName(context, read)}(${read.columns.map((name) => `stored.${info.columns.find((column) => column.column.name === name)!.attr}`).join(', ')}) is not None`,
        ),
      ...info.table.foreignKeys
        .map((key) => query(info, 'listByParent', key.columns))
        .filter((item) => item !== undefined)
        .map(
          (read) =>
            `assert ${read.columns.map((name) => `stored.${info.columns.find((column) => column.column.name === name)!.attr}`).join(' is None or ')} is None or len(${a}${repo}.${queryName(context, read)}(${read.columns.map((name) => `stored.${info.columns.find((column) => column.column.name === name)!.attr}`).join(', ')})) == 1`,
        ),
    ]),
  )
  if (list)
    blocks.push(
      ...test('lists_rows_by_key', [
        `${a}add_${info.module}(sql_uow, 1)`,
        `${a}add_${info.module}(sql_uow, 2)`,
        context.settings.paging === 'offset'
          ? [`page = ${a}${repo}.${queryName(context, list)}(0, 1)`, 'assert page.total == 2', 'assert len(page.items) == 1']
          : context.settings.paging === 'cursor'
            ? [
                `first = ${a}${repo}.${queryName(context, list)}(None, 1)`,
                'assert len(first.items) == 1 and first.next is not None',
                `second = ${a}${repo}.${queryName(context, list)}(first.next, 1)`,
                'assert len(second.items) == 1 and second.next is None',
              ]
            : [`assert len(${a}${repo}.${queryName(context, list)}()) == 2`],
      ]),
    )
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    blocks.push(
      ...test('changes_are_stored', [
        `stored = ${a}add_${info.module}(sql_uow, 1)`,
        `stored.${text.attr} = "changed"`,
        `${a}${repo}.${queryName(context, update)}(stored)`,
        `found = ${a}${repo}.${queryName(context, getByKey)}(${keyOf('stored')})`,
        `assert found is not None and found.${text.attr} == "changed"`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    blocks.push(
      ...test('is_deleted', [
        `stored = ${a}add_${info.module}(sql_uow, 1)`,
        `${a}${repo}.${queryName(context, remove)}(stored)`,
        `assert ${a}${repo}.${queryName(context, getByKey)}(${keyOf('stored')}) is None`,
      ]),
    )
  return blocks
}

// Service tests

function serviceTests(context: Context, info: TableInfo, imports: Imports, uow: string): Block {
  const a = aw(context)
  const service = serviceClass(info)
  imports.from(moduleOf(context, info, 'service'), service)
  const dtos = context.settings.serviceTypes === 'dtos'
  const ops = new Map(info.operations.map((operation) => [operation.kind + ':' + operation.columns.join(','), operation]))
  const op = (kind: string, columns: string[] = []) => ops.get(kind + ':' + columns.join(','))
  const create = op('create')
  const get = op('get')
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.attr}`).join(', ')
  const test = (name: string, body: Block) => [
    '',
    '',
    `${def(context)} test_${info.module}_service_${name}(${uow}) -> None:`,
    `    service = ${service}(${uow.split(':')[0]})`,
    indent(lines(...body)),
  ]
  const uowName = uow.split(':')[0]
  const blocks: Block = []
  // Rows go in through the service (when it creates them) and the parents through the factories
  const parentsFirst: Line[] = []
  const overrides: string[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    imports.from('tests.factories', `add_${parent.module}`)
    parentsFirst.push(`parent_${index} = ${a}add_${parent.module}(${uowName}, n)`)
    key.columns.forEach((column, position) => {
      const target = parent.columns.find((item) => item.column.name === key.references.columns[position])!
      overrides.push(`${info.columns.find((item) => item.column.name === column)!.attr}=parent_${index}.${target.attr}`)
    })
  })
  if (create) {
    imports.from('tests.factories', `new_${info.module}`)
    const fresh = (n: number, extra: string[] = []) => {
      const args = [`${n}`, ...overrides, ...extra].join(', ')
      return dtos ? `${createDto(info)}(**_values(new_${info.module}(${args})))` : `new_${info.module}(${args})`
    }
    if (dtos) imports.from(moduleOf(context, info, 'dtos'), createDto(info))
    const name = operationName(context, create)
    blocks.push(
      ...test('creates_a_valid_row', [
        'n = 1',
        ...parentsFirst,
        `created = ${a}service.${name}(${fresh(1)})`,
        get && `found = ${a}service.${operationName(context, get)}(${keyOf('created')})`,
        get && info.key.map((column) => `assert found.${column.attr} == created.${column.attr}`),
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      imports.from('app.errors', 'ValidationFailedError')
      const missing = dtos
        ? `${createDto(info)}.model_construct(**(_values(new_${info.module}(${['1', ...overrides].join(', ')})) | {"${required.attr}": None}))`
        : `new_${info.module}(${['1', ...overrides, `${required.attr}=None`].join(', ')})`
      const pydanticOrEntity =
        dtos && context.settings.dtoKind === 'dataclass'
          ? `${createDto(info)}(**(_values(new_${info.module}(${['1', ...overrides].join(', ')})) | {"${required.attr}": None}))`
          : missing
      blocks.push(
        ...test('refuses_a_missing_value', [
          'n = 1',
          ...parentsFirst,
          'with pytest.raises(ValidationFailedError) as raised:',
          `    ${a}service.${name}(${pydanticOrEntity})`,
          `assert [error.field for error in raised.value.errors] == ["${required.column.name}"]`,
        ]),
      )
    }
    const unique = info.table.uniques.find((item) => query(info, 'findByUnique', item.columns))
    if (unique) {
      imports.from('app.errors', 'ConflictError')
      const same = unique.columns.map((name) => {
        const attr = info.columns.find((column) => column.column.name === name)!.attr
        return `${attr}=first.${attr}`
      })
      blocks.push(
        ...test('refuses_a_repeated_unique_value', [
          'n = 1',
          ...parentsFirst,
          `first = ${a}service.${name}(${fresh(1)})`,
          'with pytest.raises(ConflictError):',
          `    ${a}service.${name}(${fresh(2, same)})`,
        ]),
      )
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      imports.from('app.errors', 'ValidationFailedError')
      const column = info.columns.find((item) => item.column.name === parentKey.columns[0])!
      const others = overrides.filter((item) => !item.startsWith(`${column.attr}=`))
      const value = missingValue(column.column.type, imports)
      const args = ['1', ...others, `${column.attr}=${value}`].join(', ')
      blocks.push(
        ...test('refuses_a_missing_parent', [
          'n = 1',
          ...parentsFirst,
          'with pytest.raises(ValidationFailedError) as raised:',
          `    ${a}service.${name}(${dtos ? `${createDto(info)}(**_values(new_${info.module}(${args})))` : `new_${info.module}(${args})`})`,
          `assert "${parentKey.columns[0]}" in [error.field for error in raised.value.errors]`,
        ]),
      )
    }
  }
  if (get) {
    imports.from('app.errors', 'NotFoundError')
    blocks.push(
      ...test('says_when_a_row_is_missing', [
        'with pytest.raises(NotFoundError):',
        `    ${a}service.${operationName(context, get)}(${info.key.map((column) => missingValue(column.column.type, imports)).join(', ')})`,
      ]),
    )
  }
  const update = op('update')
  const text = changeableText(info)
  if (create && update && text) {
    const version = info.version ? ', version=created.' + info.version.attr : ''
    const change = dtos ? `${updateDto(info)}(${text.attr}="changed")` : `{"${text.attr}": "changed"}`
    if (dtos) imports.from(moduleOf(context, info, 'dtos'), updateDto(info))
    blocks.push(
      ...test('changes_a_row', [
        'n = 1',
        ...parentsFirst,
        `created = ${a}service.${operationName(context, create)}(${dtos ? `${createDto(info)}(**_values(new_${info.module}(${['1', ...overrides].join(', ')})))` : `new_${info.module}(${['1', ...overrides].join(', ')})`})`,
        `updated = ${a}service.${operationName(context, update)}(${keyOf('created')}, ${change}${version})`,
        `assert updated.${text.attr} == "changed"`,
      ]),
    )
  }
  const remove = op('delete')
  if (create && remove && get) {
    imports.from('app.errors', 'NotFoundError')
    const version = info.version ? ', version=created.' + info.version.attr : ''
    blocks.push(
      ...test('deletes_a_row', [
        'n = 1',
        ...parentsFirst,
        `created = ${a}service.${operationName(context, create)}(${dtos ? `${createDto(info)}(**_values(new_${info.module}(${['1', ...overrides].join(', ')})))` : `new_${info.module}(${['1', ...overrides].join(', ')})`})`,
        `${a}service.${operationName(context, remove)}(${keyOf('created')}${version})`,
        'with pytest.raises(NotFoundError):',
        `    ${a}service.${operationName(context, get)}(${keyOf('created')})`,
      ]),
    )
  }
  return blocks
}

/** The keyword arguments of an entity's columns, for building a create DTO from a factory row. */
function valuesHelper(): Line[] {
  return [
    '',
    '',
    'def _values(entity: object) -> dict[str, object]:',
    '    """The column values of an entity that is not stored, for building a DTO from a factory row."""',
    '    return {name: value for name, value in vars(entity).items() if not name.startswith("_")}',
  ]
}

/** Fails when the tests do not run on the database TEST_DATABASE_URL names, so a green run proves which one it was. */
function databaseTest(context: Context): GeneratedFile {
  return {
    path: 'tests/test_database.py',
    content: lines(
      '"""The tests run on the database they were asked to."""',
      '',
      'import os',
      '',
      '',
      `${def(context)} test_runs_on_the_database_asked(engine) -> None:  # type: ignore[no-untyped-def]`,
      '    url = os.environ.get("TEST_DATABASE_URL")',
      '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
      '    assert engine.dialect.name == expected',
      '',
    ),
  }
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [
    conftestFile(context),
    factoriesFile(context, makeable),
    { path: 'tests/__init__.py', content: '' },
    databaseTest(context),
  ]
  for (const info of makeable) {
    const imports = new Imports().module('pytest').from('app.unit_of_work', 'SqlUnitOfWork')
    const blocks: Block = []
    if (tests === 'all' || tests === 'repositories') blocks.push(...repositoryTests(context, info, imports))
    if ((tests === 'all' || tests === 'services') && info.service) {
      const memory = context.settings.memoryRepositories
      if (memory) imports.from('app.unit_of_work', 'MemoryUnitOfWork')
      blocks.push(...serviceTests(context, info, imports, memory ? 'memory_uow: MemoryUnitOfWork' : 'sql_uow: SqlUnitOfWork'))
      if (context.settings.serviceTypes === 'dtos') blocks.push(...valuesHelper())
    }
    if (blocks.length === 0) continue
    const content = lines(
      `"""Tests of the "${info.name}" table${context.async ? ' (asynchronous: pytest-asyncio runs every test function)' : ''}."""`,
      '',
      imports.write('app'),
      ...blocks,
      '',
    )
    files.push({ path: `tests/test_${info.module}.py`, content })
  }
  return files
}
