/**
 * The repositories of each table: the interface services depend on (when the settings want one), its Exposed
 * implementation (DSL queries on the table object, each in a transaction that joins the one already open, rows
 * turned into entities, writes stored at once so a database refusal becomes a ConflictException, what the database
 * fills read back after an insert), and its in-memory one, with the same methods. Repositories decide nothing.
 */
import type { QueryDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import {
  columnOf,
  commonPackage,
  errorsPackage,
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
import { ktLiteral } from './entities.ts'
import { KtImports, ktString } from './kotlin.ts'
import { EXPOSED_TRANSACTION } from './support.ts'

const CORE = 'org.jetbrains.exposed.v1.core'
const JDBC = 'org.jetbrains.exposed.v1.jdbc'

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
      case 'delete':
        add([{ name: 'entity', type: entity }], 'Unit', 'Removes a row.')
        break
    }
  }
  return methods
}

const signature = (method: Method) =>
  `fun ${method.name}(${method.params.map((param) => `${param.name}: ${param.type}`).join(', ')}): ${method.returns}`

// Exposed

const t = (info: TableInfo, column: ColumnInfo) => `${info.tableObject}.${column.prop}`

/** The condition that leaves out rows marked as deleted. */
function softCondition(info: TableInfo, imports: KtImports): string | null {
  if (!info.soft) return null
  imports.add(`${CORE}.isNull`)
  const column = t(info, info.soft)
  if (info.soft.column.type.kind !== 'boolean') return `${column}.isNull()`
  imports.add(`${CORE}.eq`, `${CORE}.or`)
  return `((${column} eq false) or ${column}.isNull())`
}

/** Conditions joined with `and`, each between parentheses when there are several. */
function all(conditions: string[], imports: KtImports): string {
  if (conditions.length > 1) imports.add(`${CORE}.and`)
  return conditions.length === 1 ? conditions[0] : conditions.map((condition) => `(${condition})`).join(' and ')
}

/** The columns written by an insert: not those the database fills (uuids are made first). */
const insertColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined || column.column.generated === 'uuid')

/** The columns written by an update: not the key, nor those the database fills. */
const updateColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined && !info.key.includes(column))

/** The row of an entity, by its key. */
function keyCondition(info: TableInfo, imports: KtImports): string {
  imports.add(`${CORE}.eq`)
  return all(
    info.key.map((column) => `${t(info, column)} eq entity.${column.prop}${column.column.nullable ? '' : '!!'}`),
    imports,
  )
}

function orderBy(info: TableInfo, imports: KtImports): string {
  imports.add(`${CORE}.SortOrder`)
  return `.orderBy(${info.key.map((column) => `${t(info, column)} to SortOrder.ASC`).join(', ')})`
}

/** The query of a list, read with or without conditions. */
const select = (info: TableInfo, condition: string | null) => `${info.tableObject}.selectAll()${condition ? `.where { ${condition} }` : ''}`

function exposedBody(context: Context, info: TableInfo, method: Method, imports: KtImports): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info, imports)
  const byColumns = () => {
    imports.add(`${CORE}.eq`)
    return columns.map((column) => `${t(info, column)} eq ${column.prop}`)
  }
  const read = (lines: string[]) => ['return exposedTransaction(db) {', ...lines.map((line) => `    ${line}`), '}']
  imports.add(`${JDBC}.selectAll`)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return read([`${select(info, all([...byColumns(), ...(soft ? [soft] : [])], imports))}.map { toEntity(it) }.singleOrNull()`])
    case 'listByParent':
    case 'findAllBy':
      return read([
        `${select(info, all([...byColumns(), ...(soft ? [soft] : [])], imports))}${orderBy(info, imports)}.map { toEntity(it) }`,
      ])
    case 'list': {
      if (context.settings.paging === 'offset')
        return read([
          `val query = ${select(info, soft)}`,
          'val total = query.count()',
          `val items = query${orderBy(info, imports)}.limit(limit).offset(offset.toLong()).map { toEntity(it) }`,
          'Page(items, total, offset, limit)',
        ])
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        imports.add(`${CORE}.greater`)
        if (info.key.length > 1) imports.add(`${CORE}.eq`, `${CORE}.or`)
        const value = (column: ColumnInfo, index: number) => `(after[${index}] as ${column.kt})`
        const after = info.key
          .map((column, index) =>
            all(
              [
                ...info.key.slice(0, index).map((before, position) => `${t(info, before)} eq ${value(before, position)}`),
                `${t(info, column)} greater ${value(column, index)}`,
              ],
              imports,
            ),
          )
          .map((item) => (info.key.length > 1 ? `(${item})` : item))
          .join(' or ')
        const withAfter = soft ? all([soft, after], imports) : after
        return read([
          `val query = if (after == null) ${select(info, soft)} else ${select(info, withAfter)}`,
          `val rows = query${orderBy(info, imports)}.limit(limit + 1).map { toEntity(it) }`,
          'val items = rows.take(limit)',
          `CursorPage(items, if (rows.size > limit) listOf<Any>(${info.key.map((column) => `items.last().${column.prop}!!`).join(', ')}) else null)`,
        ])
      }
      return read([`${select(info, soft)}${orderBy(info, imports)}.map { toEntity(it) }`])
    }
    case 'insert': {
      imports.add(`${JDBC}.insert`)
      const uuids = info.columns
        .filter((column) => column.column.generated === 'uuid')
        .map((column) => {
          imports.add('java.util.UUID')
          return `    entity.${column.prop} = entity.${column.prop} ?: UUID.randomUUID()`
        })
      const identity = info.table.primaryKey?.length === 1 ? info.key.find((column) => column.column.generated === 'identity') : undefined
      return [
        'return write {',
        ...uuids,
        `    ${identity ? 'val statement = ' : ''}${info.tableObject}.insert { row ->`,
        ...insertColumns(info).map((column) => `        entity.${column.prop}?.let { row[${t(info, column)}] = it }`),
        '    }',
        ...(identity ? [`    entity.${identity.prop} = statement[${t(info, identity)}]`] : []),
        // What the database filled is read back, by the key the row now has
        ...(info.table.primaryKey ? [`    fill(entity, ${select(info, keyCondition(info, imports))}.single())`] : []),
        '    entity',
        '}',
      ]
    }
    case 'update':
      imports.add(`${JDBC}.update`)
      return [
        'return write {',
        `    ${info.tableObject}.update({ ${keyCondition(info, imports)} }) { row ->`,
        ...updateColumns(info).map((column) =>
          column.column.nullable
            ? `        row[${t(info, column)}] = entity.${column.prop}`
            : `        entity.${column.prop}?.let { row[${t(info, column)}] = it }`,
        ),
        '    }',
        '    entity',
        '}',
      ]
    case 'delete':
      imports.add(`${JDBC}.deleteWhere`)
      return ['write {', `    ${info.tableObject}.deleteWhere { ${keyCondition(info, imports)} }`, '}']
    default:
      return ['throw UnsupportedOperationException()']
  }
}

/** toEntity, fill and write: how rows become entities, and how a refusal of the database becomes a ConflictException. */
function exposedHelpers(context: Context, info: TableInfo, imports: KtImports): string[] {
  imports.add(`${CORE}.ResultRow`)
  const writes = info.queries.some((item) => item.kind === 'insert' || item.kind === 'update' || item.kind === 'delete')
  if (writes) imports.add('org.jetbrains.exposed.v1.exceptions.ExposedSQLException', qualified(errorsPackage(context), 'ConflictException'))
  return [
    '',
    `    private fun toEntity(row: ResultRow): ${info.entity} = ${info.entity}().also { fill(it, row) }`,
    '',
    `    private fun fill(entity: ${info.entity}, row: ResultRow) {`,
    ...info.columns.map((column) => `        entity.${column.prop} = row[${t(info, column)}]`),
    '    }',
    ...(writes
      ? [
          '',
          '    /** Runs a write in a transaction; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */',
          '    private fun <T> write(work: () -> T): T =',
          '        try {',
          '            exposedTransaction(db) { work() }',
          '        } catch (error: ExposedSQLException) {',
          '            // SQLSTATE class 23: the change breaks a constraint (SQLite says so in its message)',
          '            if (!error.sqlState.startsWith("23") && error.cause?.message?.contains("SQLITE_CONSTRAINT") != true) throw error',
          `            throw ConflictException(${ktString(info.entity)}, "the database refused the change: \${error.cause?.message}")`,
          '        }',
        ]
      : []),
  ]
}

// In memory

function memoryFill(info: TableInfo, column: ColumnInfo, imports: KtImports): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  if (db.generated === 'identity') {
    const next = column.kt === 'Long' ? 'nextId++' : column.kt === 'Short' ? '(nextId++).toShort()' : '(nextId++).toInt()'
    return `${target} = ${target} ?: ${next}`
  }
  if (db.generated === 'uuid') {
    imports.add('java.util.UUID')
    return `${target} = ${target} ?: UUID.randomUUID()`
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    if (column.ktImport) imports.add(column.ktImport)
    return ['LocalDate', 'LocalTime', 'LocalDateTime', 'OffsetDateTime'].includes(column.kt)
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

function memoryBody(context: Context, info: TableInfo, method: Method): string[] {
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
      return ['rows[keyOf(entity)] = entity', 'return entity']
    case 'delete':
      return ['rows.remove(keyOf(entity))']
    default:
      return ['throw UnsupportedOperationException()']
  }
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
    const imports = new KtImports(pkg).add(
      entityClass,
      qualified(packageOf(context, info, 'entity'), info.tableObject),
      EXPOSED_TRANSACTION,
    )
    imports.add(`${JDBC}.Database`)
    const methods = repositoryMethods(context, info, imports)
    const modifier = interfaces ? 'override ' : 'open '
    const bodies = methods.flatMap((item) => block(item, exposedBody(context, info, item, imports), modifier, !interfaces))
    const helpers = exposedHelpers(context, info, imports)
    files.push(
      ktFile(pathOf(pkg, sqlRepositoryClass(info)), pkg, imports.write(), [
        `/** Keeps ${info.name} rows in the database, through Exposed. ${
          context.settings.transactions === 'caller'
            ? 'Every call joins the transaction of whoever holds the database, when there is one.'
            : 'Every call joins the transaction already open, or is committed at once.'
        } */`,
        interfaces
          ? `class ${sqlRepositoryClass(info)}(private val db: Database) : ${repositoryInterface(info)} {`
          : `open class ${sqlRepositoryClass(info)}(private val db: Database?) {`,
        ...bodies.slice(1),
        ...helpers,
        '}',
      ]),
    )
  }
  if (context.settings.memoryRepositories) {
    const imports = new KtImports(pkg).add(entityClass)
    const methods = repositoryMethods(context, info, imports)
    const fills = info.columns.map((column) => memoryFill(info, column, imports)).filter((line): line is string => line !== null)
    const bodies = methods.flatMap((item) => {
      const body = memoryBody(context, info, item)
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
