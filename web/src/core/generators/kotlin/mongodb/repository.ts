/**
 * The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
 * are not as they were read (so two people changing different fields do not undo each other, and the ones the entity
 * does not know are kept), and one item of a list is added or removed in the database.
 */
import { isObjectId } from '../../../schema/documents.ts'
import { columnOf, query, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, listOf } from '../documents.ts'
import { ktString, type KtImports } from '../kotlin.ts'
import { memoryFill, type Method } from '../repositories.ts'
import { documentFunctions, encode } from './values.ts'

const changeable = (info: TableInfo, column: ColumnInfo) =>
  !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const updates = (info: TableInfo) => query(info, 'update') !== undefined && info.columns.some((column) => changeable(info, column))
const touchedBy = (info: TableInfo) => info.columns.filter(({ column }) => column.generated === 'onUpdateNow')

const equal = (column: ColumnInfo, value: string, imports: KtImports): [string, string] => [
  column.column.name,
  encode(column.column.type, value, null, imports),
]

const softCondition = (info: TableInfo): [string, string][] => {
  if (!info.soft) return []
  return [[info.soft.column.name, info.soft.column.type.kind === 'boolean' ? 'Document("\\$ne", true)' : 'null']]
}

/** `Document("a", a).append("b", b)` */
function filter(conditions: [string, string][]): string {
  if (conditions.length === 0) return 'Document()'
  const [[name, value], ...others] = conditions
  return `Document(${ktString(name)}, ${value})${others.map(([other, item]) => `.append(${ktString(other)}, ${item})`).join('')}`
}

/** What a text that is not an identifier finds. */
const guards = (columns: ColumnInfo[], nothing: string, imports: KtImports) =>
  columns
    .filter((column) => isObjectId(column.column.type))
    .map((column) => {
      imports.add('org.bson.types.ObjectId')
      return `if (!ObjectId.isValid(${column.prop})) return ${nothing}`
    })

export function head(context: Context, info: TableInfo): string[] {
  return [
    ...(context.settings.repositoryInterfaces
      ? []
      : ['    private val db get() = checkNotNull(held) { "This repository has no database" }', '']),
    `    private val collection = ${ktString(info.name)}`,
    ...(updates(info)
      ? [
          '',
          '    /** The fields a change may write */',
          `    private val fields = listOf(${info.columns
            .filter((column) => changeable(info, column))
            .map((column) => ktString(column.column.name))
            .join(', ')})`,
        ]
      : []),
  ]
}

const key = (info: TableInfo) => info.key[0]
const sorted = (info: TableInfo) => `sort = Document(${ktString(key(info).column.name)}, 1)`

export function body(context: Context, info: TableInfo, method: Method, imports: KtImports): string[] {
  imports.add('org.bson.Document')
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const given = () => filter([...columns.map((column) => equal(column, column.prop, imports)), ...soft])
  const entity = ktString(info.entity)
  const read = updates(info) ? 'loaded(it)' : 'fromDocument(it)'
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [...guards(columns, 'null', imports), `return db.find(collection, ${given()}, limit = 1).firstOrNull()?.let { ${read} }`]
    case 'listByParent':
    case 'findAllBy':
      return [...guards(columns, 'emptyList()', imports), `return db.find(collection, ${given()}, ${sorted(info)}).map { ${read} }`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          `val items = if (limit > 0) db.find(collection, ${filter(soft)}, ${sorted(info)}, skip = offset, limit = limit).map { ${read} } else emptyList()`,
          `return Page(items, db.count(collection, ${filter(soft)}), offset, limit)`,
        ]
      if (context.settings.paging === 'cursor')
        return [
          `val filter = ${filter(soft)}`,
          `if (after != null) filter[${ktString(key(info).column.name)}] = Document("\\$gt", ${encode(key(info).column.type, `after[0] as ${key(info).kt}`, null, imports)})`,
          `val rows = db.find(collection, filter, ${sorted(info)}, limit = limit + 1).map { ${read} }`,
          'val items = rows.take(limit)',
          `return CursorPage(items, if (rows.size > limit) listOf(items.last().${key(info).prop}!!) else null)`,
        ]
      return [`return db.find(collection, ${filter(soft)}, ${sorted(info)}).map { ${read} }`]
    case 'insert':
      return [
        // MongoDB fills nothing but the identifier
        ...info.columns.map((column) => memoryFill(column, imports)).filter((line): line is string => line !== null),
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems()'] : []),
        `db.insert(${entity}, collection, toDocument(entity))`,
        ...(updates(info) ? ['READ[entity] = Documents.copy(toDocument(entity)) as Document'] : []),
        'return entity',
      ]
    case 'update': {
      if (!updates(info)) return ['// Nothing of it can change but its key', 'return entity']
      imports.add('app.Documents')
      const touched = touchedBy(info)
      for (const column of touched) if (column.ktImport) imports.add(column.ktImport)
      return [
        ...touched.map((column) => `entity.${column.prop} = ${column.kt}.now()`),
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems()'] : []),
        'val now = toDocument(entity)',
        'val changes = Documents.changes(READ[entity], now, fields)',
        'if (changes.isNotEmpty()) {',
        ...touched.map(
          ({ column }) =>
            `    (changes.getOrPut("\\$set") { Document() } as Document)[${ktString(column.name)}] = now[${ktString(column.name)}]`,
        ),
        `    db.update(${entity}, collection, Document("_id", now["_id"]), changes)`,
        '}',
        'READ[entity] = Documents.copy(now) as Document',
        'return entity',
      ]
    }
    case 'delete':
      return [`db.delete(${entity}, collection, ${filter([equal(key(info), `entity.${key(info).prop}!!`, imports)])})`]
    case 'addItem':
    case 'removeItem':
      return itemBody(info, method, imports)
    default:
      return ['throw UnsupportedOperationException()']
  }
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(info: TableInfo, method: Method, imports: KtImports): string[] {
  const list = listOf(info, method.query)
  const [param] = list.params
  const path = ktString(list.column.column.name)
  const touched = touchedBy(info).map(({ column }): [string, string] => {
    imports.add('java.util.Date')
    return [column.name, 'Date()']
  })
  const version = info.version?.column.name
  const conditions = [equal(key(info), key(info).prop, imports), ...softCondition(info)]
  const result = guards([key(info)], 'null', imports)
  const adds = method.query.kind === 'addItem'
  if (!adds && list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    conditions.push([list.column.column.name, 'Document("\\$size", size)'])
    const kept = ktString(`$${list.column.column.name}`)
    const sets: [string, string][] = [
      [list.column.column.name, 'Document("\\$concatArrays", listOf(head, tail))'],
      ...touched,
      ...(version ? [[version, `Document("\\$add", listOf(${ktString(`$${version}`)}, 1))`] as [string, string]] : []),
    ]
    result.push(
      `val head = Document("\\$slice", listOf(${kept}, position))`,
      `val tail = Document("\\$slice", listOf(${kept}, position + 1, maxOf(size, 1)))`,
      `val change = listOf(Document("\\$set", ${filter(sets)}))`,
    )
  } else {
    let main: string
    if (adds) {
      if (list.by === 'id') {
        imports.add('org.bson.types.ObjectId')
        result.push(`${list.item}.id = ${list.item}.id ?: ObjectId().toHexString()`)
      }
      main = `Document("\\$push", Document(${path}, ${encode(list.type, list.item, list.nested, imports)}))`
    } else if (list.by === 'id') {
      imports.add('org.bson.types.ObjectId')
      result.push(`if (!ObjectId.isValid(${param.name})) return null`)
      main = `Document("\\$pull", Document(${path}, Document("_id", ObjectId(${param.name}))))`
    } else main = `Document("\\$pull", Document(${path}, ${encode(list.type, param.name, list.nested, imports)}))`
    const also = [
      ...(touched.length > 0 ? [`.append("\\$set", ${filter(touched)})`] : []),
      ...(version ? [`.append("\\$inc", Document(${ktString(version)}, 1))`] : []),
    ].join('')
    result.push(`val change = listOf(${main}${also})`)
  }
  const call = !adds && list.by === 'position' ? 'rewrite' : 'change'
  return [
    ...result.map((line) => (call === 'change' ? line.replace(/^val change = listOf\((.*)\)$/, 'val change = $1') : line)),
    `return db.${call}(${ktString(info.entity)}, collection, ${filter(conditions)}, change)?.let { ${updates(info) ? 'loaded(it)' : 'fromDocument(it)'} }`,
  ]
}

export function helpers(_context: Context, info: TableInfo, imports: KtImports): string[] {
  if (updates(info)) imports.add('app.Documents', 'java.util.Collections', 'java.util.WeakHashMap')
  return [
    ...(updates(info)
      ? [
          '',
          '    /** The entity of a document, with the document kept to tell its changes. */',
          `    private fun loaded(document: Document): ${info.entity} {`,
          '        val entity = fromDocument(document)',
          '        READ[entity] = Documents.copy(toDocument(entity)) as Document',
          '        return entity',
          '    }',
        ]
      : []),
    ...documentFunctions(
      info.entity,
      info.columns.map((column) => ({
        name: column.column.name,
        type: column.column.type,
        prop: column.prop,
        nested: info.nested.get(column.column.name) ?? null,
      })),
      info.nested.values(),
      imports,
    ),
    ...(updates(info)
      ? [
          '',
          '    private companion object {',
          '        /** The document each entity was read from: a change writes only the fields that differ */',
          `        val READ: MutableMap<${info.entity}, Document> = Collections.synchronizedMap(WeakHashMap())`,
          '    }',
        ]
      : []),
  ]
}
