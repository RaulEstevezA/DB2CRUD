/**
 * The tests of a generated Java project, which are also what the verification runs (JUnit): factories that build
 * valid rows (and their parents first), repository tests against a real database created from the entities, and
 * service tests on the in-memory unit of work (or on the database when the project has no memory repositories).
 * The database is SQLite in a file of target/ unless TEST_DATABASE_URL names another. Mirrors
 * typescript/common/tests.ts.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines, type Line } from '../types.ts'
import { capitalized, javaPath, javaString, JavaImports } from './java.ts'
import { listOf, type ListInfo, type NestedClass } from './documents.ts'
import type { DbType } from '../../schema/types.ts'
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
import { missingValue, sampleImports, sampleValue } from './samples.ts'

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
        // No sample is sure to fit a type that is not known
        if (column.column.nullable && (isKey || column.column.type.kind === 'unknown')) return []
        for (const name of sampleImports(column)) imports.add(name)
        const value =
          documentValue(context, info, column) ??
          (column.column.type.kind === 'array'
            ? context.orm.emptyList(context)
            : sampleValue(column, info.table.checks, context.schema.enums))
        return [`        entity.${column.setter}(${value});`]
      })
    const insert = query(info, 'insert')!
    const documents = [...info.nested.values()].flatMap((item) => nestedFactories(context, info, item, imports))
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
      ...documents,
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

const factoryOf = (item: NestedClass) => `new${item.path.split('.').join('')}`

/** A column that holds documents, or a list of them, as a Java expression; null for any other. */
function documentValue(context: Context, info: TableInfo, column: ColumnInfo): string | null {
  const nested = info.nested.get(column.column.name)
  if (!context.orm.documents || !nested) return null
  return nestedValue(column.column.type, nested)
}

const nestedValue = (type: DbType, nested: NestedClass): string =>
  type.kind === 'array' ? `new java.util.ArrayList<>(List.of(${nestedValue(type.items, nested)}))` : `${factoryOf(nested)}(n)`

/** A factory per class of nested document, without the identifier it is given when it is stored. */
function nestedFactories(context: Context, info: TableInfo, item: NestedClass, imports: JavaImports): string[] {
  imports.add('java.util.List')
  const values = item.fields
    .filter((field) => field.column.name !== '_id' && field.column.type.kind !== 'unknown')
    .map((field) => {
      const column = { column: field.column, java: field.java, javaImport: null } as ColumnInfo
      if (field.java.includes('BigDecimal')) imports.add('java.math.BigDecimal')
      if (field.java.includes('Instant')) imports.add('java.time.Instant')
      if (field.java.includes('UUID')) imports.add('java.util.UUID')
      const value = field.nested
        ? nestedValue(field.column.type, field.nested)
        : field.column.type.kind === 'array'
          ? context.orm.emptyList(context)
          : sampleValue(column, field.column.checks ?? [], context.schema.enums)
      return `        item.${field.setter}(${value});`
    })
  return [
    '',
    `    /** A valid ${item.path}. */`,
    `    static ${item.path} ${factoryOf(item)}(int n) {`,
    `        ${item.path} item = new ${item.path}();`,
    ...values,
    '        return item;',
    '    }',
    ...item.classes.flatMap((inner) => nestedFactories(context, info, inner, imports)),
  ]
}

/** A value for an item of a list, as a Java expression for the number 7. */
function itemSample(context: Context, list: ListInfo): string {
  if (list.nested && list.type.kind === 'json') return `Factories.${factoryOf(list.nested)}(7)`
  if (list.type.kind === 'array' || list.type.kind === 'json') return context.orm.emptyList(context)
  return sampleValue(
    { ...list.column, column: { ...list.column.column, type: list.type }, java: list.java },
    [],
    context.schema.enums,
  ).replace(/\bn\b/g, '7')
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

/** The assertion that two values of a column are the same: arrays are compared by what they hold. */
const same = (column: ColumnInfo) => (column.java === 'byte[]' ? 'org.junit.jupiter.api.Assertions.assertArrayEquals' : 'assertEquals')

function repositoryTests(context: Context, info: TableInfo, imports: JavaImports): Line[][] {
  for (const adding of info.queries.filter((item) => item.kind === 'addItem')) addItemImports(info, adding, imports)
  const repo = `uow.${info.attr}()`
  const keyOf = (variable: string) => info.key.map((column) => `${variable}.${column.getter}()`).join(', ')
  const getByKey = query(info, 'getByKey')
  const list = query(info, 'list')
  const tests: Line[][] = []
  const stored = `${info.entity} stored = Factories.${addName(info)}(uow, 1);`
  tests.push(
    test('isStoredAndReadBack', [
      stored,
      context.orm.forget,
      getByKey && [
        `${info.entity} found = ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).orElseThrow();`,
        ...info.key.map((column) => `${same(column)}(stored.${column.getter}(), found.${column.getter}());`),
      ],
      ...info.table.uniques
        .map((unique) => query(info, 'findByUnique', unique.columns))
        .filter((item) => item !== undefined)
        .map((read) => {
          // A unique value that may be null is looked up only when the row has one
          const args = read.columns.map((name) => `stored.${columnOf(info, name).getter}()`)
          const optional = read.columns
            .filter((name) => columnOf(info, name).column.nullable)
            .map((name) => `stored.${columnOf(info, name).getter}()`)
          const assert = `assertTrue(${repo}.${queryName(context, read)}(${args.join(', ')}).isPresent());`
          return optional.length > 0 ? `if (${optional.map((arg) => `${arg} != null`).join(' && ')}) ${assert}` : assert
        }),
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
        context.orm.forget,
        `assertEquals("changed", ${repo}.${queryName(context, getByKey)}(${keyOf('stored')}).orElseThrow().${text.getter}());`,
      ]),
    )
  for (const adding of info.queries.filter((item) => item.kind === 'addItem')) {
    const list = listOf(info, adding)
    const removing = query(info, 'removeItem', adding.columns)
    if (!removing || !getByKey) continue
    const get = list.column.getter
    const which = list.by === 'id' ? `added.${get}().get(before).getId()` : list.by === 'value' ? 'item' : `before, added.${get}().size()`
    tests.push(
      test(`addsAndRemovesOneItemOf${capitalized(list.column.prop)}`, [
        stored,
        `int before = stored.${get}() == null ? 0 : stored.${get}().size();`,
        `${list.java} item = ${itemSample(context, list)};`,
        `${info.entity} added = ${repo}.${queryName(context, adding)}(${keyOf('stored')}, item).orElseThrow();`,
        `assertEquals(before + 1, added.${get}().size());`,
        `${info.entity} removed = ${repo}.${queryName(context, removing)}(${keyOf('stored')}, ${which}).orElseThrow();`,
        `assertEquals(before, removed.${get}().size());`,
        ...(list.by === 'position'
          ? [`assertTrue(${repo}.${queryName(context, removing)}(${keyOf('stored')}, 0, before + 5).isEmpty());`]
          : []),
      ]),
    )
  }
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

function addItemImports(info: TableInfo, query: Parameters<typeof listOf>[1], imports: JavaImports): void {
  const list = listOf(info, query)
  if (list.column.javaImport) imports.add(list.column.javaImport)
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
  // The parents take a number the rows of the test never take: a parent may be a row of the same table
  const start = ['int n = 100;', ...parentsFirst]
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
          ...info.key.map((column) => `${same(column)}(${valueOf('created', column)}, ${valueOf('found', column)});`),
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
  for (const operation of info.operations.filter((item) => item.kind === 'addItem')) {
    const list = listOf(info, operation)
    const without = op('removeItem', operation.columns)
    if (!create || !without || info.hidden.includes(list.column.column.name)) continue
    addItemImports(info, operation, imports)
    imports.add(`${errorsPackage(context)}.NotFoundException`)
    const items = (variable: string) => valueOf(variable, list.column)
    const which = list.by === 'id' ? `${items('added')}.get(before).getId()` : list.by === 'value' ? 'item' : 'before'
    const missing = list.by === 'id' ? `"${'f'.repeat(24)}"` : list.by === 'value' ? null : '99'
    tests.push(
      test(`addsAndRemovesOneItemOf${capitalized(list.column.prop)}`, [
        ...open,
        ...start,
        ...row('row', 1),
        `var created = service.${operationName(context, create)}(${input('row')});`,
        `int before = ${items('created')} == null ? 0 : ${items('created')}.size();`,
        `${list.java} item = ${itemSample(context, list)};`,
        `var added = service.${operationName(context, operation)}(${keyOf('created')}, item${version('created')});`,
        `assertEquals(before + 1, ${items('added')}.size());`,
        `var removed = service.${operationName(context, without)}(${keyOf('created')}, ${which}${version('added')});`,
        `assertEquals(before, ${items('removed')}.size());`,
        ...(missing
          ? [
              `assertThrows(NotFoundException.class, () -> service.${operationName(context, without)}(${keyOf('created')}, ${missing}${version('removed')}));`,
            ]
          : []),
      ]),
    )
  }
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
  const files: GeneratedFile[] = [...context.orm.testDatabaseFiles(context), factoriesFile(context, makeable)]
  const memory = context.settings.memoryRepositories
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
      nested.push('', '    @Nested', '    class Repository {', ...repositoryTests(context, info, imports).flat(), '    }')
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
    // Written before the imports, which it adds to
    const session = database ? context.orm.testSession(context, imports) : null
    const content = lines(
      `package ${pkg};`,
      '',
      imports.write(),
      '',
      `/** Tests of the "${info.name}" table. */`,
      `class ${className} {`,
      session,
      ...nested,
      '}',
      '',
    )
    files.push({ path: javaPath(pkg, className, true), content })
  }
  return files
}
