/**
 * The tests of a generated Rust project, which are also what the verification runs (`cargo test`): one test crate,
 * `tests/data/`, with factories that build valid rows (and their parents first), repository tests against a real
 * database created from the SeaORM entities, and service tests on the in-memory unit of work (or on the database when
 * the project has no memory repositories). Every test takes its turn at the database. The database is SQLite in a new
 * temporary file unless TEST_DATABASE_URL names another. Mirrors kotlin/tests.ts.
 */
import type { GeneratedFile } from '../../export/files.ts'
import {
  columnOf,
  findInfo,
  moduleOf,
  operationName,
  pathIn,
  query,
  queryName,
  serviceType,
  writesEntities,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, updateColumns, updatePath, updateType } from './dtos.ts'
import { RsUses, owned, rsString, snakeName } from './rust.ts'
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

const newName = (info: TableInfo) => `new_${info.module.replace(/^r#/, '')}`
const addName = (info: TableInfo) => `add_${info.module.replace(/^r#/, '')}`
const ind = (items: string[], spaces = 4) => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
export const TESTS = 'tests/data'
export const UNIT_OF_WORK = (context: Context) => `${context.crate}::unit_of_work`
/** A path of the crate, as the tests name it: `crate::errors` → `data_access::errors`. */
export const external = (context: Context, path: string) => path.replace(/^crate::/, `${context.crate}::`)

/** The value of a field known to be set, copied: `stored.id.expect(…)`. */
const known = (expression: string, column: ColumnInfo) =>
  `${column.copy ? expression : `${expression}.clone()`}.expect(${rsString(`${column.key} is set`)})`

/** An Option of a value, copied. */
const option = (expression: string, column: ColumnInfo) => (column.copy ? expression : `${expression}.clone()`)

// Factories

function factoriesFile(context: Context, makeable: TableInfo[]): GeneratedFile {
  const uses = new RsUses().add(`${UNIT_OF_WORK(context)}::UnitOfWork`)
  const blocks = makeable.map((info) => {
    uses.add(external(context, pathIn(moduleOf(context, info, 'entity'), info.entity)))
    const parents: string[] = []
    const fromParents: string[] = []
    const parentColumns = new Set<string>()
    info.table.foreignKeys.forEach((key, index) => {
      const parent = findInfo(context, key.references.table)
      if (isNullableKey(info, key) || !parent) return
      parents.push(`    let parent${index} = ${addName(parent)}(uow, n).await;`)
      key.columns.forEach((column, position) => {
        parentColumns.add(column)
        const target = columnOf(parent, key.references.columns[position])
        fromParents.push(`    entity.${columnOf(info, column).field} = ${option(`parent${index}.${target.field}`, target)};`)
      })
    })
    const values = info.columns
      .filter((column) => !column.generated && !parentColumns.has(column.column.name))
      .flatMap((column) => {
        const isKey = info.table.foreignKeys.some((key) => key.columns.includes(column.column.name))
        if (column === info.soft) return column.column.type.kind === 'boolean' ? [`        ${column.field}: Some(false),`] : []
        // No sample is sure to fit a type that is not known
        if (column.column.nullable && (isKey || column.column.type.kind === 'unknown')) return []
        const value =
          column.column.type.kind === 'array'
            ? context.orm.emptyList(context)
            : sampleValue(column, info.table.checks, context.schema.enums)
        return [`        ${column.field}: Some(${value}),`]
      })
    const usesN = values.some((line) => /\bn\b/.test(line))
    const insert = query(info, 'insert')!
    return [
      `/// A valid ${info.entity} that is not stored yet; n makes its unique values differ.`,
      `pub fn ${newName(info)}(${usesN ? 'n' : '_n'}: i32) -> ${info.entity} {`,
      `    ${info.entity} {`,
      ...values,
      '        ..Default::default()',
      '    }',
      '}',
      '',
      `/// A stored ${info.entity}${parents.length > 0 ? ', with the rows it points to' : ''}.`,
      `pub async fn ${addName(info)}(uow: &dyn UnitOfWork, n: i32) -> ${info.entity} {`,
      ...parents,
      `    let ${fromParents.length > 0 ? 'mut ' : ''}entity = ${newName(info)}(n);`,
      ...fromParents,
      `    uow.${info.attr}().${queryName(context, insert)}(entity).await.expect(${rsString(`a stored ${info.entity}`)})`,
      '}',
    ]
  })
  return {
    path: `${TESTS}/factories.rs`,
    content: [
      '//! Rows for the tests: valid values for every column, and the rows they point to.',
      '',
      '// Not every test uses every factory',
      '#![allow(dead_code)]',
      '',
      uses.write(),
      ...blocks.flatMap((block) => ['', ...block]),
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

function test(name: string, body: (string | string[] | false | null | undefined)[]): string[] {
  const lines = body.flat().filter((line): line is string => typeof line === 'string')
  // A parent made for a column the test then sets itself is not made: Rust refuses a variable nobody uses
  const used = lines.filter((line) => {
    const parent = /^let (parent\d+) = /.exec(line)?.[1]
    return !parent || lines.some((other) => other !== line && other.includes(`${parent}.`))
  })
  return ['', '#[tokio::test]', `async fn ${name}() {`, ...ind(used), '}']
}

/** An assertion on a stored row's values, made only when those that may be None have one. */
function whenSet(columns: ColumnInfo[], assertion: string): string[] {
  const optional = columns.filter((column) => column.column.nullable)
  if (optional.length === 0) return [assertion]
  return [`if ${optional.map((column) => `stored.${column.field}.is_some()`).join(' && ')} {`, `    ${assertion}`, '}']
}

function repositoryTests(context: Context, info: TableInfo): string[][] {
  const repo = `uow.${info.attr}()`
  const keyOf = (variable: string) => info.key.map((column) => known(`${variable}.${column.field}`, column)).join(', ')
  const args = (columns: ColumnInfo[]) => columns.map((column) => known(`stored.${column.field}`, column)).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const tests: string[][] = []
  const open = 'let (_turn, uow) = database::open().await;'
  const checks = [
    ...info.table.uniques
      .map((unique) => query(info, 'findByUnique', unique.columns))
      .filter((item) => item !== undefined)
      .flatMap((read) => {
        const columns = read.columns.map((name) => columnOf(info, name))
        return whenSet(columns, `assert!(${repo}.${queryName(context, read)}(${args(columns)}).await.expect("a read").is_some());`)
      }),
    ...info.table.foreignKeys
      .map((key) => query(info, 'listByParent', key.columns))
      .filter((item) => item !== undefined)
      .flatMap((read) => {
        const columns = read.columns.map((name) => columnOf(info, name))
        return whenSet(columns, `assert_eq!(1, ${repo}.${queryName(context, read)}(${args(columns)}).await.expect("a read").len());`)
      }),
  ]
  const usesStored = getByKey !== undefined || checks.length > 0
  tests.push(
    test('is_stored_and_read_back', [
      open,
      `let ${usesStored ? 'stored' : '_stored'} = factories::${addName(info)}(&uow, 1).await;`,
      getByKey && [
        `let found = ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).await.expect("a read").expect("the row");`,
        ...info.key.map((column) => `assert_eq!(stored.${column.field}, found.${column.field});`),
      ],
      ...checks,
    ]),
  )
  if (list) {
    const name = queryName(context, list)
    tests.push(
      test('lists_rows_by_key', [
        open,
        `factories::${addName(info)}(&uow, 1).await;`,
        `factories::${addName(info)}(&uow, 2).await;`,
        context.settings.paging === 'offset'
          ? [`let page = ${repo}.${name}(0, 1).await.expect("a page");`, 'assert_eq!(2, page.total);', 'assert_eq!(1, page.items.len());']
          : context.settings.paging === 'cursor'
            ? [
                `let first = ${repo}.${name}(None, 1).await.expect("a page");`,
                'assert_eq!(1, first.items.len());',
                'assert!(first.next.is_some());',
                `let second = ${repo}.${name}(first.next, 1).await.expect("a page");`,
                'assert_eq!(1, second.items.len());',
                'assert!(second.next.is_none());',
              ]
            : [`assert_eq!(2, ${repo}.${name}().await.expect("the rows").len());`],
      ]),
    )
  }
  const update = query(info, 'update')
  const text = changeableText(info)
  if (update && getByKey && text)
    tests.push(
      test('stores_the_changes', [
        open,
        `let mut stored = factories::${addName(info)}(&uow, 1).await;`,
        `stored.${text.field} = Some(${owned('changed')});`,
        `${repo}.${queryName(context, update)}(stored.clone()).await.expect("an update");`,
        `let found = ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).await.expect("a read");`,
        `assert_eq!(Some(${owned('changed')}), found.and_then(|row| row.${text.field}));`,
      ]),
    )
  const remove = query(info, 'delete')
  if (remove && getByKey && !info.soft)
    tests.push(
      test('is_deleted', [
        open,
        `let stored = factories::${addName(info)}(&uow, 1).await;`,
        `${repo}.${queryName(context, remove)}(&stored).await.expect("a delete");`,
        `assert!(${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).await.expect("a read").is_none());`,
      ]),
    )
  return tests
}

function serviceTests(context: Context, info: TableInfo, uses: RsUses): string[][] {
  const service = serviceType(info)
  uses.add(external(context, pathIn(moduleOf(context, info, 'service'), service)))
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
    dtos && !column.column.nullable
      ? column.copy
        ? `${variable}.${column.field}`
        : `${variable}.${column.field}.clone()`
      : known(`${variable}.${column.field}`, column)
  /** A column of what the service returns, as an Option */
  const optionOf = (variable: string, column: ColumnInfo) =>
    dtos && !column.column.nullable
      ? `Some(${column.copy ? `${variable}.${column.field}` : `${variable}.${column.field}.clone()`})`
      : option(`${variable}.${column.field}`, column)
  const keyOf = (variable: string) => info.key.map((column) => member(variable, column)).join(', ')
  // Rows go in through the service (when it creates them) and the parents through the factories, numbered 100: the
  // rows of the test never take that number, and a parent may be a row of the same table
  const parentsFirst: string[] = []
  const overrides: { column: string; value: string }[] = []
  info.table.foreignKeys.forEach((key, index) => {
    const parent = findInfo(context, key.references.table)
    if (!parent || !canMake(context, parent)) return
    parentsFirst.push(`let parent${index} = factories::${addName(parent)}(uow.as_ref(), 100).await;`)
    key.columns.forEach((column, position) => {
      const target = columnOf(parent, key.references.columns[position])
      overrides.push({ column, value: option(`parent${index}.${target.field}`, target) })
    })
  })
  const row = (variable: string, n: number, extra: { column: string; value: string }[] = []) => {
    const given = new Set(extra.map((item) => item.column))
    const assignments = [...overrides.filter((item) => !given.has(item.column)), ...extra]
    return [
      `let ${assignments.length > 0 ? 'mut ' : ''}${variable} = factories::${newName(info)}(${n});`,
      ...assignments.map((item) => `${variable}.${columnOf(info, item.column).field} = ${item.value};`),
    ]
  }
  const input = (variable: string) => (dtos ? `create_of(${variable})` : variable)
  /** The changes of an update that sets one field, and keeps the others as the row has them */
  const changes = (target: ColumnInfo, value: { option: string; stored: string }, source: string) => {
    uses.add(external(context, updatePath(context, info)))
    const type = updateType(context, info)
    const mode = context.settings.updates
    if (mode === 'patch') {
      uses.add(`${context.crate}::common::Patch`)
      return `${type} { ${target.field}: Patch::Set(${value.option}), ..Default::default() }`
    }
    if (mode === 'optional') return `${type} { ${target.field}: Some(${value.option}), ..Default::default() }`
    const fields = updateColumns(info).map(
      (column) =>
        `${column.field}: ${column === target ? value.stored : column.column.nullable ? option(`${source}.${column.field}`, column) : known(`${source}.${column.field}`, column)}`,
    )
    return `${type} { ${fields.join(', ')} }`
  }
  const version = (variable: string) => (info.version ? `, ${member(variable, info.version)}` : '')
  const tests: string[][] = []
  const open = memory
    ? ['let uow = Arc::new(MemoryUnitOfWork::default());', `let service = ${service}::new(uow.clone());`]
    : ['let (_turn, uow) = database::open().await;', 'let uow = Arc::new(uow);', `let service = ${service}::new(uow.clone());`]
  const errors = () => uses.add(`${context.crate}::errors::DomainError`)
  if (create) {
    const name = operationName(context, create)
    tests.push(
      test('creates_a_valid_row', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        get
          ? [
              `let created = service.${name}(${input('row')}).await.expect("a create");`,
              `let found = service.${operationName(context, get)}(${keyOf('created')}).await.expect("a read");`,
              ...info.key.map((column) => `assert_eq!(created.${column.field}, found.${column.field});`),
            ]
          : dtos
            ? [`service.${name}(${input('row')}).await.expect("a create");`]
            : [
                `let created = service.${name}(${input('row')}).await.expect("a create");`,
                ...info.key.map((column) => `assert!(created.${column.field}.is_some());`),
              ],
      ]),
    )
    const required = info.columns.find(
      (column) => column.required && !info.table.foreignKeys.some((key) => key.columns.includes(column.column.name)),
    )
    if (required) {
      errors()
      tests.push(
        test('refuses_a_missing_value', [
          ...open,
          ...parentsFirst,
          ...row('row', 1, [{ column: required.column.name, value: 'None' }]),
          `let error = service.${name}(${input('row')}).await.expect_err("a refusal");`,
          'let DomainError::ValidationFailed { errors, .. } = &error else { panic!("{error}") };',
          `assert_eq!(vec![${rsString(required.column.name)}], errors.iter().map(|error| error.field.as_str()).collect::<Vec<_>>());`,
        ]),
      )
    }
    // A unique value the client gives: one the database fills is never sent
    const unique = info.table.uniques.find(
      (item) => query(info, 'findByUnique', item.columns) && item.columns.every((name) => !columnOf(info, name).generated),
    )
    if (unique) {
      errors()
      const own = unique.columns.map((column) => columnOf(info, column))
      tests.push(
        test('refuses_a_repeated_unique_value', [
          ...open,
          ...parentsFirst,
          ...row('row', 1),
          `let first = service.${name}(${input('row')}).await.expect("a create");`,
          ...row(
            'again',
            2,
            own.map((column) => ({ column: column.column.name, value: optionOf('first', column) })),
          ),
          `assert!(matches!(service.${name}(${input('again')}).await, Err(DomainError::Conflict { .. })));`,
        ]),
      )
      if (update && own.length === 1 && own.every((column) => !info.key.includes(column) && !column.generated)) {
        const target = own[0]
        const kept = {
          option: optionOf('created', target),
          stored: target.column.nullable ? optionOf('created', target) : member('created', target),
        }
        tests.push(
          test('keeps_its_own_unique_value', [
            ...open,
            ...parentsFirst,
            ...row('row', 1),
            `let created = service.${name}(${input('row.clone()')}).await.expect("a create");`,
            `let updated = service.${operationName(context, update)}(${keyOf('created')}, ${changes(target, kept, 'row')}${version('created')}).await.expect("an update");`,
            `assert_eq!(created.${target.field}, updated.${target.field});`,
          ]),
        )
      }
    }
    const parentKey = info.table.foreignKeys.find((key) => {
      const parent = findInfo(context, key.references.table)
      return parent && query(parent, 'getByKey') && key.columns.length === 1
    })
    if (parentKey) {
      errors()
      const column = columnOf(info, parentKey.columns[0])
      tests.push(
        test('refuses_a_missing_parent', [
          ...open,
          ...parentsFirst,
          ...row('row', 1, [{ column: column.column.name, value: `Some(${missingValue(column)})` }]),
          `let error = service.${name}(${input('row')}).await.expect_err("a refusal");`,
          'let DomainError::ValidationFailed { errors, .. } = &error else { panic!("{error}") };',
          `assert!(errors.iter().any(|error| error.field == ${rsString(parentKey.columns[0])}));`,
        ]),
      )
    }
  }
  if (get) {
    errors()
    tests.push(
      test('says_when_a_row_is_missing', [
        ...open,
        `assert!(matches!(service.${operationName(context, get)}(${info.key.map(missingValue).join(', ')}).await, Err(DomainError::NotFound { .. })));`,
      ]),
    )
  }
  const text = changeableText(info)
  if (create && update && text) {
    const changed = owned('changed')
    tests.push(
      test('changes_a_row', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `let created = service.${operationName(context, create)}(${input('row.clone()')}).await.expect("a create");`,
        `let updated = service.${operationName(context, update)}(${keyOf('created')}, ${changes(text, { option: `Some(${changed})`, stored: text.column.nullable ? `Some(${changed})` : changed }, 'row')}${version('created')}).await.expect("an update");`,
        dtos && !text.column.nullable
          ? `assert_eq!(updated.${text.field}, "changed");`
          : `assert_eq!(updated.${text.field}, Some(${changed}));`,
      ]),
    )
  }
  if (create && deletes && get) {
    errors()
    tests.push(
      test('deletes_a_row', [
        ...open,
        ...parentsFirst,
        ...row('row', 1),
        `let created = service.${operationName(context, create)}(${input('row')}).await.expect("a create");`,
        `service.${operationName(context, deletes)}(${keyOf('created')}${version('created')}).await.expect("a delete");`,
        `assert!(matches!(service.${operationName(context, get)}(${keyOf('created')}).await, Err(DomainError::NotFound { .. })));`,
      ]),
    )
  }
  return tests
}

/** Builds a create DTO from a factory row: the values of its fields. */
function createOfHelper(context: Context, info: TableInfo, uses: RsUses): string[] {
  uses.add(external(context, pathIn(moduleOf(context, info, 'dtos'), createDto(info))))
  return [
    '',
    '/// The create DTO of a row the factories made.',
    `fn create_of(row: ${info.entity}) -> ${createDto(info)} {`,
    `    ${createDto(info)} { ${createColumns(info)
      .map((column) => `${column.field}: row.${column.field}`)
      .join(', ')} }`,
    '}',
  ]
}

export function testFiles(context: Context): GeneratedFile[] {
  const tests = context.settings.tests
  if (tests === 'none' || !writesEntities(context)) return []
  const makeable = context.tables.filter((info) => canMake(context, info))
  const files: GeneratedFile[] = [context.orm.testDatabaseFile(context), factoriesFile(context, makeable)]
  const modules = ['database', 'factories']
  const memory = context.settings.memoryRepositories
  for (const info of makeable) {
    const entityPath = external(context, pathIn(moduleOf(context, info, 'entity'), info.entity))
    const base = snakeName(info.module.replace(/^r#/, ''))
    if (tests === 'all' || tests === 'repositories') {
      const uses = new RsUses().add('super::database', 'super::factories', `${UNIT_OF_WORK(context)}::UnitOfWork`)
      const blocks = repositoryTests(context, info)
      const module = `${base}_repository`
      modules.push(module)
      files.push({
        path: `${TESTS}/${module}.rs`,
        content: [
          `//! The repository of the "${info.name}" table, against the test database.`,
          '',
          uses.write(),
          ...blocks.flat(),
          '',
        ].join('\n'),
      })
    }
    if ((tests === 'all' || tests === 'services') && info.service !== null) {
      const uses = new RsUses().add('std::sync::Arc')
      if (memory) uses.add(`${UNIT_OF_WORK(context)}::MemoryUnitOfWork`)
      const blocks = serviceTests(context, info, uses)
      if (blocks.length === 0) continue
      const all = blocks.flat().join('\n')
      // The factories and the test database, when the tests name them
      if (all.includes('factories::')) uses.add('super::factories')
      if (all.includes('database::')) uses.add('super::database')
      const dtosHelper = context.settings.serviceTypes === 'dtos' && /create_of\(/.test(all)
      if (dtosHelper) uses.add(entityPath)
      const helper = dtosHelper ? createOfHelper(context, info, uses) : []
      const module = `${base}_service`
      modules.push(module)
      files.push({
        path: `${TESTS}/${module}.rs`,
        content: [
          `//! The service of the "${info.name}" table, on ${memory ? 'the in-memory repositories' : 'the test database'}.`,
          '',
          uses.write(),
          ...blocks.flat(),
          ...helper,
          '',
        ].join('\n'),
      })
    }
  }
  files.push({
    path: `${TESTS}/main.rs`,
    content: [
      '//! The tests of the data access layer: the repositories against a real database, the services on the in-memory',
      '//! repositories (or on the database when the project has none).',
      '',
      ...modules.map((module) => `mod ${module};`),
      '',
    ].join('\n'),
  })
  return files
}
