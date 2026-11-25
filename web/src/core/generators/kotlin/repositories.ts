/**
 * The repositories of each table: the interface services depend on (when the settings want one), its database
 * implementation (its bodies are the strategy's, orm.ts), and its in-memory one, with the same methods. Repositories
 * decide nothing.
 */
import type { QueryDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import {
  columnOf,
  commonPackage,
  ktFile,
  memoryRepositoryClass,
  packageOf,
  pathOf,
  qualified,
  queryName,
  repositoryInterface,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { isObjectId } from '../../schema/documents.ts'
import { identifiedLists, listOf } from './documents.ts'
import { KtImports, ktString } from './kotlin.ts'

export interface Method {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

/** The methods of a table's repository, with their Kotlin signatures. */
export function repositoryMethods(context: Context, info: TableInfo, imports: KtImports): Method[] {
  const entity = info.entity
  const methods: Method[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns.map((column) => {
      const info2 = columnOf(info, column)
      if (info2.ktImport) imports.add(info2.ktImport)
      return { name: info2.prop, type: info2.kt }
    })
    const add = (params: Method['params'], returns: string, doc: string) => methods.push({ query, name, params, returns, doc })
    switch (query.kind) {
      case 'getByKey':
        add(byColumns, `${entity}?`, 'The row with this primary key, or null.')
        break
      case 'findByUnique':
        add(byColumns, `${entity}?`, `The row with this ${query.columns.join(' and ')}, or null.`)
        break
      case 'listByParent':
      case 'findAllBy':
        add(byColumns, `List<${entity}>`, `Rows with this ${query.columns.join(' and ')}, by primary key.`)
        break
      case 'list':
        if (context.settings.paging === 'offset') {
          imports.add(qualified(commonPackage(context), 'Page'))
          add(
            [
              { name: 'offset', type: 'Int' },
              { name: 'limit', type: 'Int' },
            ],
            `Page<${entity}>`,
            'At most limit rows from offset, by primary key, and how many there are.',
          )
        } else if (context.settings.paging === 'cursor') {
          imports.add(qualified(commonPackage(context), 'CursorPage'))
          add(
            [
              { name: 'after', type: 'List<Any>?' },
              { name: 'limit', type: 'Int' },
            ],
            `CursorPage<${entity}>`,
            'At most limit rows after the key after (null for the first page), by primary key, and the key to read the next page from.',
          )
        } else add([], `List<${entity}>`, 'Every row, by primary key.')
        break
      case 'insert':
        add([{ name: 'entity', type: entity }], entity, 'Stores a new row; the values the database fills are read back.')
        break
      case 'update':
        add([{ name: 'entity', type: entity }], entity, 'Stores the changes made to a row.')
        break
      case 'addItem':
      case 'removeItem': {
        const list = listOf(info, query)
        if (list.column.ktImport) imports.add(list.column.ktImport)
        const adds = query.kind === 'addItem'
        // Told apart by its position, it is only removed from a list of the size it was seen in
        const size = !adds && list.by === 'position' ? [{ name: 'size', type: 'Int' }] : []
        add(
          [
            ...info.key.map((column) => ({ name: column.prop, type: column.kt })),
            ...(adds ? [{ name: list.item, type: list.kt }] : list.params),
            ...size,
          ],
          `${entity}?`,
          adds
            ? `Adds an item to ${query.columns[0]}, and gives the row as it is then, if there is one.`
            : `Removes an item from ${query.columns[0]}${size.length > 0 ? ' that has this size' : ''}, and gives the row as it is then, if there is one.`,
        )
        break
      }
      case 'delete':
        add([{ name: 'entity', type: entity }], 'Unit', 'Removes a row.')
        break
    }
  }
  return methods
}

const signature = (method: Method) =>
  `fun ${method.name}(${method.params.map((param) => `${param.name}: ${param.type}`).join(', ')}): ${method.returns}`

// In memory

/** A literal of a default, in the column's Kotlin type. */
export function ktLiteral(column: ColumnInfo, value: string | number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  const text = String(value)
  switch (column.kt) {
    case 'Long':
      return `${text}L`
    case 'Int':
      return text
    case 'Short':
      return `${text}.toShort()`
    case 'BigDecimal':
      return `BigDecimal(${ktString(text)})`
    case 'Double':
      return /[.eE]/.test(text) ? text : `${text}.0`
    case 'Float':
      return `${text}f`
    case 'Boolean':
      return text
    case 'LocalDate':
    case 'LocalTime':
    case 'LocalDateTime':
    case 'OffsetDateTime':
    case 'Instant':
      return `${column.kt}.parse(${ktString(text)})`
    case 'UUID':
      return `UUID.fromString(${ktString(text)})`
    default:
      return ktString(text)
  }
}

export function memoryFill(column: ColumnInfo, imports: KtImports): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  if (db.generated === 'identity') {
    const next = column.kt === 'Long' ? 'nextId++' : column.kt === 'Short' ? '(nextId++).toShort()' : '(nextId++).toInt()'
    return `${target} = ${target} ?: ${next}`
  }
  if (db.generated === 'uuid' && isObjectId(db.type)) {
    imports.add('org.bson.types.ObjectId')
    return `${target} = ${target} ?: ObjectId().toHexString()`
  }
  if (db.generated === 'uuid') {
    imports.add('java.util.UUID')
    return `${target} = ${target} ?: UUID.randomUUID()`
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    if (column.ktImport) imports.add(column.ktImport)
    return ['LocalDate', 'LocalTime', 'LocalDateTime', 'OffsetDateTime', 'Instant'].includes(column.kt)
      ? `${target} = ${target} ?: ${column.kt}.now()`
      : null
  }
  if (db.default?.kind === 'literal' && db.default.value !== null) {
    if (column.ktImport) imports.add(column.ktImport)
    return `${target} = ${target} ?: ${ktLiteral(column, db.default.value)}`
  }
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return 'true'
  return info.soft.column.type.kind === 'boolean' ? `it.${info.soft.prop} != true` : `it.${info.soft.prop} == null`
}

function memoryBody(context: Context, info: TableInfo, method: Method, imports: KtImports): string[] {
  const conditions = method.query.columns.map((name) => `it.${columnOf(info, name).prop} == ${columnOf(info, name).prop}`).join(' && ')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return visible().firstOrNull { ${conditions} }`]
    case 'listByParent':
    case 'findAllBy':
      return [`return visible().filter { ${conditions} }`]
    case 'list':
      if (context.settings.paging === 'offset')
        return ['val rows = visible()', 'return Page(rows.drop(offset).take(limit), rows.size.toLong(), offset, limit)']
      if (context.settings.paging === 'cursor')
        return [
          'val rows = visible().filter { after == null || compareKeys(keyOf(it), after) > 0 }',
          'val items = rows.take(limit)',
          'return CursorPage(items, if (rows.size > limit) keyOf(items.last()).map { it!! } else null)',
        ]
      return ['return visible()']
    case 'insert':
    case 'update':
      return [...(identifiedLists(info).length > 0 ? ['entity.identifyItems()'] : []), 'rows[keyOf(entity)] = entity', 'return entity']
    case 'addItem':
    case 'removeItem':
      return memoryItem(info, method, imports)
    case 'delete':
      return ['rows.remove(keyOf(entity))']
    default:
      return ['throw UnsupportedOperationException()']
  }
}

/** One item of a list added or removed in memory. */
function memoryItem(info: TableInfo, method: Method, imports: KtImports): string[] {
  const list = listOf(info, method.query)
  const [param] = list.params
  const items = `found.${list.column.prop}`
  const adds = method.query.kind === 'addItem'
  const position = !adds && list.by === 'position'
  const keys = info.key.map((column) => `it.${column.prop} == ${column.prop}`).join(' && ')
  if (adds && list.by === 'id') imports.add('org.bson.types.ObjectId')
  const version = info.version
  const touched = info.columns.filter(({ column }) => column.generated === 'onUpdateNow')
  for (const column of touched) if (column.ktImport) imports.add(column.ktImport)
  const change = adds
    ? [
        ...(list.by === 'id' ? [`${list.item}.id = ${list.item}.id ?: ObjectId().toHexString()`] : []),
        // A list in a list is one item, not several
        `${items} = ${items}.orEmpty() + listOf(${list.item})`,
      ]
    : position
      ? [`${items} = ${items}.orEmpty().filterIndexed { index, _ -> index != position }`]
      : [`${items} = ${items}.orEmpty().filter { it${list.by === 'id' ? '.id' : ''} != ${param.name} }`]
  return [
    `val found = visible().firstOrNull { ${keys} } ?: return null`,
    ...(position ? [`if (${items}.orEmpty().size != size) return null`] : []),
    ...change,
    ...(version ? [`found.${version.prop} = (found.${version.prop} ?: 0) + 1`] : []),
    ...touched.map((column) => `found.${column.prop} = ${column.kt}.now()`),
    'return found',
  ]
}

function block(method: Method, body: string[], modifier: string, doc: boolean): string[] {
  return [
    '',
    ...(doc ? [`    /** ${method.doc} */`] : []),
    `    ${modifier}${signature(method)} {`,
    ...body.map((line) => `        ${line}`),
    '    }',
  ]
}

export function repositoryFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const pkg = packageOf(context, info, 'repository')
  const entityClass = qualified(packageOf(context, info, 'entity'), info.entity)
  const interfaces = context.settings.repositoryInterfaces
  const files: GeneratedFile[] = []
  if (interfaces) {
    const imports = new KtImports(pkg).add(entityClass)
    const methods = repositoryMethods(context, info, imports)
    files.push(
      ktFile(pathOf(pkg, repositoryInterface(info)), pkg, imports.write(), [
        `/** Where ${info.name} rows are kept. Services depend only on this interface. */`,
        `interface ${repositoryInterface(info)} {`,
        ...methods
          .flatMap((item, index) => [index > 0 ? '' : null, `    /** ${item.doc} */`, `    ${signature(item)}`])
          .filter((line): line is string => line !== null),
        '}',
      ]),
    )
  }
  {
    const { holder, repository } = context.orm
    const imports = new KtImports(pkg).add(entityClass, holder.ktImport, ...repository.imports(context, info))
    const methods = repositoryMethods(context, info, imports)
    const modifier = interfaces ? 'override ' : 'open '
    const head = repository.head(context, info)
    const bodies = methods.flatMap((item) => block(item, repository.body(context, info, item, imports), modifier, !interfaces))
    const helpers = repository.helpers(context, info, imports)
    const kept = repository.kept(context)
    files.push(
      ktFile(pathOf(pkg, sqlRepositoryClass(info)), pkg, imports.write(), [
        `/** Keeps ${info.name} rows in the database, ${repository.doc(context)} */`,
        interfaces
          ? `class ${sqlRepositoryClass(info)}(private val ${kept}: ${holder.type}) : ${repositoryInterface(info)} {`
          : `open class ${sqlRepositoryClass(info)}(private val ${kept}: ${holder.type}?) {`,
        ...head,
        ...(head.length > 0 ? bodies : bodies.slice(1)),
        ...helpers,
        '}',
      ]),
    )
  }
  if (context.settings.memoryRepositories) {
    const imports = new KtImports(pkg).add(entityClass)
    const methods = repositoryMethods(context, info, imports)
    const fills = info.columns.map((column) => memoryFill(column, imports)).filter((line): line is string => line !== null)
    const bodies = methods.flatMap((item) => {
      const body = memoryBody(context, info, item, imports)
      return block(item, item.query.kind === 'insert' ? [...fills, ...body] : body, 'override ', false)
    })
    const identity = info.columns.some((column) => column.column.generated === 'identity')
    files.push(
      ktFile(
        pathOf(pkg, memoryRepositoryClass(info)),
        pkg,
        imports.write(),
        [
          `/** Keeps ${info.name} rows in memory, for tests and for trying the services without a database. */`,
          interfaces
            ? `class ${memoryRepositoryClass(info)} : ${repositoryInterface(info)} {`
            : `class ${memoryRepositoryClass(info)} : ${sqlRepositoryClass(info)}(null) {`,
          `    private val rows = linkedMapOf<List<Any?>, ${info.entity}>()`,
          identity ? '    private var nextId = 1L' : null,
          '',
          '    /** The key of a row, as a list of its key values. */',
          `    private fun keyOf(row: ${info.entity}): List<Any?> = listOf(${info.key.map((column) => `row.${column.prop}`).join(', ')})`,
          '',
          '    /** Orders two keys value by value. */',
          '    @Suppress("UNCHECKED_CAST")',
          '    private fun compareKeys(a: List<Any?>, b: List<Any?>): Int {',
          '        for (index in a.indices) {',
          '            val order = compareValues(a[index] as Comparable<Any>?, b[index] as Comparable<Any>?)',
          '            if (order != 0) return order',
          '        }',
          '        return 0',
          '    }',
          '',
          `    private fun visible(): List<${info.entity}> =`,
          `        rows.values.filter { ${memoryVisible(info)} }.sortedWith { a, b -> compareKeys(keyOf(a), keyOf(b)) }`,
          ...bodies,
          '}',
        ].filter((line): line is string => line !== null),
      ),
    )
  }
  return files
}
