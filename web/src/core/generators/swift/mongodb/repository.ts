/**
 * The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
 * are not as they were read (so two people changing different fields do not undo each other, and the ones the entity
 * does not know are kept), and one item of a list is added or removed in the database.
 */
import { isObjectId } from '../../../schema/documents.ts'
import { columnOf, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, listOf } from '../documents.ts'
import { memoryFill, type Method } from '../repositories.ts'
import { swString } from '../swift.ts'
import { encoded } from './values.ts'

const changeable = (info: TableInfo) =>
  info.columns.filter((column) => !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow')

const touchedBy = (info: TableInfo) => info.columns.filter(({ column }) => column.generated === 'onUpdateNow')

/** `"_id": try Bson.ofObjectId(id)` */
const equal = (column: ColumnInfo, value: string) => `${swString(column.column.name)}: ${encoded(column.column.type, value)}`

function softCondition(info: TableInfo): string[] {
  if (!info.soft) return []
  return [`${swString(info.soft.column.name)}: ${info.soft.column.type.kind === 'boolean' ? '["$ne": true] as BsonDocument' : 'Bson.null'}`]
}

const doc = (conditions: string[]) => (conditions.length === 0 ? '[:]' : `[${conditions.join(', ')}]`)
const nestedDoc = (conditions: string[]) => `${doc(conditions)} as BsonDocument`

/** What a text that is not an identifier finds. */
const guards = (columns: ColumnInfo[], nothing: string) =>
  columns
    .filter((column) => isObjectId(column.column.type))
    .map((column) => `guard Bson.isObjectId(${column.prop}) else { return ${nothing} }`)

const key = (info: TableInfo) => info.key[0]

export function body(context: Context, info: TableInfo, method: Method): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const given = () => `let documentFilter: BsonDocument = ${doc([...columns.map((column) => equal(column, column.prop)), ...soft])}`
  const collection = swString(info.name)
  const sort = `sort: [${swString(key(info).column.name)}: 1]`
  const every = `let documentFilter: BsonDocument = ${doc(soft)}`
  const entities = `.map(${info.entity}.from)`
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        ...guards(columns, 'nil'),
        given(),
        `return try await database.find(${collection}, documentFilter, limit: 1).first${entities}`,
      ]
    case 'listByParent':
    case 'findAllBy':
      return [...guards(columns, '[]'), given(), `return try await database.find(${collection}, documentFilter, ${sort})${entities}`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          every,
          `let total = try await database.count(${collection}, documentFilter)`,
          `let found = limit > 0 ? try await database.find(${collection}, documentFilter, ${sort}, skip: offset, limit: limit) : []`,
          `return Page(items: try found${entities}, total: total, offset: offset, limit: limit)`,
        ]
      if (context.settings.paging === 'cursor')
        return [
          `var documentFilter: BsonDocument = ${doc(soft)}`,
          `if let after { documentFilter[${swString(key(info).column.name)}] = [${swString('$gt')}: ${encoded(key(info).column.type, 'after')}] as BsonDocument }`,
          `let rows = try await database.find(${collection}, documentFilter, ${sort}, limit: limit + 1)${entities}`,
          'let items = Array(rows.prefix(limit))',
          `return CursorPage(items: items, next: rows.count > limit ? items.last?.${key(info).prop} : nil)`,
        ]
      return [every, `return try await database.find(${collection}, documentFilter, ${sort})${entities}`]
    case 'insert':
      return [
        'var entity = entity',
        // MongoDB fills nothing but the identifier
        ...info.columns.map(memoryFill).filter((line): line is string => line !== null),
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems()'] : []),
        'let document = try entity.toDocument()',
        `try await write { try await database.insert(${collection}, document) }`,
        'entity.loadedDocument = Loaded(document: document)',
        'return entity',
      ]
    case 'update': {
      const fields = changeable(info)
      if (fields.length === 0) return ['// Nothing of it can change but its key', 'return entity']
      const touched = touchedBy(info)
      return [
        'var entity = entity',
        ...touched.map((column) => `entity.${column.prop} = Date()`),
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems()'] : []),
        'let now = try entity.toDocument()',
        `let fields = [${fields.map((column) => swString(column.column.name)).join(', ')}]`,
        'let changes = Bson.changes(entity.loadedDocument.document, now, fields)',
        'if !changes.isEmpty, let id = now["_id"] {',
        ...(touched.length > 0
          ? [`    let stamped = Bson.alsoSet(changes, now, [${touched.map(({ column }) => swString(column.name)).join(', ')}])`]
          : []),
        `    try await write { try await database.update(${collection}, ["_id": id], ${touched.length > 0 ? 'stamped' : 'changes'}) }`,
        '}',
        'entity.loadedDocument = Loaded(document: now)',
        'return entity',
      ]
    }
    case 'delete':
      return [
        `let documentFilter: BsonDocument = ${doc([equal(key(info), `entity.${key(info).prop}!`)])}`,
        `try await write { try await database.delete(${collection}, documentFilter) }`,
      ]
    case 'addItem':
    case 'removeItem':
      return itemBody(info, method)
    default:
      return ['fatalError("not written")']
  }
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(info: TableInfo, method: Method): string[] {
  const list = listOf(info, method.query)
  const [param] = list.params
  const path = swString(list.column.column.name)
  const touched = touchedBy(info).map(({ column }) => `${swString(column.name)}: try Bson.ofDate(Date())`)
  const version = info.version?.column.name
  const conditions = [equal(key(info), key(info).prop), ...softCondition(info)]
  const result = guards([key(info)], 'nil')
  const adds = method.query.kind === 'addItem'
  if (!adds && list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    conditions.push(`${path}: ${nestedDoc(['"$size": size'])}`)
    const kept = swString(`$${list.column.column.name}`)
    const sets = [
      `${path}: ${nestedDoc(['"$concatArrays": [head, tail] as BsonDocument'])}`,
      ...touched,
      ...(version ? [`${swString(version)}: ${nestedDoc([`"$add": [${swString(`$${version}`)}, Int32(1)] as BsonDocument`])}`] : []),
    ]
    result.push(
      `let head: BsonDocument = ["$slice": [${kept}, position] as BsonDocument]`,
      `let tail: BsonDocument = ["$slice": [${kept}, position + 1, max(size, 1)] as BsonDocument]`,
      `let set: BsonDocument = ${doc(sets)}`,
      'let change: BsonDocument = [["$set": set] as BsonDocument]',
    )
  } else {
    let main: string
    if (adds) {
      if (list.by === 'id') result.push(`var ${list.item} = ${list.item}`, `${list.item}.id = ${list.item}.id ?? Bson.newId()`)
      main = `"$push": ${nestedDoc([`${path}: ${encoded(list.type, list.item, list.nested)}`])}`
    } else if (list.by === 'id') {
      result.push(`guard Bson.isObjectId(${param.name}) else { return nil }`)
      main = `"$pull": ${nestedDoc([`${path}: ${nestedDoc([`"_id": try Bson.ofObjectId(${param.name})`])}`])}`
    } else main = `"$pull": ${nestedDoc([`${path}: ${encoded(list.type, param.name, list.nested)}`])}`
    const also = [
      ...(touched.length > 0 ? [`"$set": ${nestedDoc(touched)}`] : []),
      ...(version ? [`"$inc": ${nestedDoc([`${swString(version)}: Int32(1)`])}`] : []),
    ]
    result.push(`let change: BsonDocument = ${doc([main, ...also])}`)
  }
  return [
    ...result,
    `let documentFilter: BsonDocument = ${doc(conditions)}`,
    `return try await write { try await database.change(${swString(info.name)}, documentFilter, change) }.map(${info.entity}.from)`,
  ]
}
