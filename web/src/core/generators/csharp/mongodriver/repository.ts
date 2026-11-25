/**
 * The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
 * are not as they were read (so two people changing different fields do not undo each other, and the ones the entity
 * does not know are kept), and one item of a list is added or removed in the database.
 */
import { isObjectId } from '../../../schema/documents.ts'
import type { Line } from '../../types.ts'
import { csString, type CsUsings } from '../csharp.ts'
import { columnOf, query, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, listOf, type ListInfo } from '../documents.ts'
import { memoryFill, type Method } from '../repositories.ts'

const changeable = (info: TableInfo, column: ColumnInfo) =>
  !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const updates = (info: TableInfo) => query(info, 'update') !== undefined && info.columns.some((column) => changeable(info, column))

const builder = (info: TableInfo) => `Builders<${info.entity}>`
const equal = (column: ColumnInfo, value: string) => `Filter.Eq(row => row.${column.prop}, ${value})`

const softCondition = (info: TableInfo): string[] => {
  if (!info.soft) return []
  return [
    info.soft.column.type.kind === 'boolean'
      ? `Filter.Ne(row => row.${info.soft.prop}, true)`
      : `Filter.Eq(row => row.${info.soft.prop}, null)`,
  ]
}

/** `Builders<Order>.Filter.And(…)` of some conditions. */
function filter(info: TableInfo, conditions: string[]): string {
  const all = conditions.map((item) => `${builder(info)}.${item}`)
  if (all.length === 0) return `${builder(info)}.Filter.Empty`
  return all.length === 1 ? all[0] : `${builder(info)}.Filter.And(${all.join(', ')})`
}

/** What a text that is not an identifier finds. */
const guards = (columns: ColumnInfo[], nothing: string) =>
  columns
    .filter((column) => isObjectId(column.column.type))
    .map((column) => `if (!ObjectId.TryParse(${column.local}, out _)) return ${nothing};`)

const find = (info: TableInfo, conditions: string[]) => `db.Find(Collection, ${filter(info, conditions)})`
const sort = (info: TableInfo) => `.Sort(${builder(info)}.Sort.Ascending(row => row.${info.key[0].prop}))`

export function head(_context: Context, info: TableInfo): Line[] {
  return [
    `    private const string Collection = ${csString(info.name)};`,
    ...(updates(info)
      ? [
          '',
          '    /// <summary>The document each entity was read from: a change writes only the fields that differ</summary>',
          `    private static readonly ConditionalWeakTable<${info.entity}, BsonDocument> Read = [];`,
          '',
          '    /// <summary>The fields a change may write</summary>',
          `    private static readonly string[] Fields = [${info.columns
            .filter((column) => changeable(info, column))
            .map((column) => csString(column.column.name))
            .join(', ')}];`,
        ]
      : []),
  ]
}

const loaded = (info: TableInfo, expression: string) => (updates(info) ? `Loaded(${expression})` : expression)
const eachLoaded = (info: TableInfo, expression: string) => (updates(info) ? `(${expression}).Select(Loaded).ToList()` : expression)

export function body(context: Context, info: TableInfo, method: Method, usings: CsUsings): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const [key] = info.key
  const entity = csString(info.entity)
  if (updates(info)) usings.add('System.Runtime.CompilerServices')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        ...guards(columns, 'null'),
        `var found = await ${find(info, [...columns.map((column) => equal(column, column.local)), ...soft])}.FirstOrDefaultAsync();`,
        `return ${updates(info) ? 'found is null ? null : Loaded(found)' : 'found'};`,
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        ...guards(columns, '[]'),
        `return ${eachLoaded(info, `await ${find(info, [...columns.map((column) => equal(column, column.local)), ...soft])}${sort(info)}.ToListAsync()`)};`,
      ]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          `var items = ${eachLoaded(info, `await ${find(info, soft)}${sort(info)}.Skip(offset).Limit(limit).ToListAsync()`)};`,
          `return new Page<${info.entity}>(items, await db.CountAsync(Collection, ${filter(info, soft)}), offset, limit);`,
        ]
      if (context.settings.paging === 'cursor')
        return [
          `var filter = ${filter(info, soft)};`,
          `if (after is not null) filter &= ${builder(info)}.Filter.Gt(row => row.${key.prop}, (${key.cs})after[0]);`,
          `var rows = ${eachLoaded(info, `await db.Find(Collection, filter)${sort(info)}.Limit(limit + 1).ToListAsync()`)};`,
          'var items = rows.Take(limit).ToList();',
          `return new CursorPage<${info.entity}>(items, rows.Count > limit ? [items[^1].${key.prop}] : null);`,
        ]
      return [`return ${eachLoaded(info, `await ${find(info, soft)}${sort(info)}.ToListAsync()`)};`]
    case 'insert':
      return [
        // MongoDB fills nothing but the identifier
        ...info.columns.map((column) => memoryFill(context, info, column)).filter((line): line is string => line !== null),
        ...(identifiedLists(info).length > 0 ? ['entity.IdentifyItems();'] : []),
        `await db.InsertAsync(${entity}, Collection, entity);`,
        `return ${loaded(info, 'entity')};`,
      ]
    case 'update': {
      if (!updates(info)) return ['// Nothing of it can change but its key', 'await Task.CompletedTask;', 'return entity;']
      const touched = info.columns.filter(({ column }) => column.generated === 'onUpdateNow')
      return [
        ...touched.map((column) => `entity.${column.prop} = DateTime.UtcNow;`),
        ...(identifiedLists(info).length > 0 ? ['entity.IdentifyItems();'] : []),
        'var now = entity.ToBsonDocument();',
        'var changes = Documents.Changes(Read.TryGetValue(entity, out var before) ? before : null, now, Fields);',
        ...(touched.length > 0
          ? [
              'if (changes.ElementCount > 0)',
              '{',
              '    if (!changes.Contains("$set")) changes["$set"] = new BsonDocument();',
              ...touched.map(({ column }) => `    changes["$set"][${csString(column.name)}] = now[${csString(column.name)}];`),
              '}',
            ]
          : []),
        `if (changes.ElementCount > 0) await db.UpdateAsync<${info.entity}>(${entity}, Collection, new BsonDocument("_id", now["_id"]), changes);`,
        'return Loaded(entity);',
      ]
    }
    case 'delete':
      return [`await db.DeleteAsync(${entity}, Collection, ${filter(info, [equal(key, `entity.${key.prop}`)])});`]
    case 'addItem':
    case 'removeItem':
      return itemBody(info, method)
    default:
      return ['throw new NotSupportedException();']
  }
}

/** A value of the key as it is stored. */
const storedKey = (key: ColumnInfo) => storedValue(key.column.type, key.local)

function storedValue(type: ColumnInfo['column']['type'], value: string): string {
  if (isObjectId(type)) return `new ObjectId(${value})`
  if (type.kind === 'decimal') return `new BsonDecimal128(${value})`
  if (type.kind === 'uuid') return `new BsonBinaryData(${value}, GuidRepresentation.Standard)`
  if (type.kind === 'json' || type.kind === 'unknown') return value
  return `BsonValue.Create(${value})`
}

/** An item as the list keeps it. */
const storedItem = (list: ListInfo, value: string) =>
  list.nested && list.type.kind === 'json' ? `${value}.ToBsonDocument()` : storedValue(list.type, value)

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(info: TableInfo, method: Method): string[] {
  const list = listOf(info, method.query)
  const [key] = info.key
  const [param] = list.params
  const path = csString(list.column.column.name)
  const touched = info.columns.filter(({ column }) => column.generated === 'onUpdateNow').map(({ column }) => csString(column.name))
  const conditions = [
    `["_id"] = ${storedKey(key)}`,
    ...(info.soft
      ? [
          `[${csString(info.soft.column.name)}] = ${info.soft.column.type.kind === 'boolean' ? 'new BsonDocument("$ne", true)' : 'BsonNull.Value'}`,
        ]
      : []),
  ]
  const result = [...guards([key], 'null')]
  if (method.query.kind === 'removeItem' && list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    conditions.push(`[${path}] = new BsonDocument("$size", size)`)
    const stored = csString(`$${list.column.column.name}`)
    const sets = [
      `[${path}] = new BsonDocument("$concatArrays", new BsonArray { head, tail })`,
      ...touched.map((name) => `[${name}] = DateTime.UtcNow`),
      ...(info.version
        ? [
            `[${csString(info.version.column.name)}] = new BsonDocument("$add", new BsonArray { ${csString(`$${info.version.column.name}`)}, 1 })`,
          ]
        : []),
    ]
    result.push(
      `var head = new BsonDocument("$slice", new BsonArray { ${stored}, position });`,
      `var tail = new BsonDocument("$slice", new BsonArray { ${stored}, position + 1, Math.max(size, 1) });`.replace(
        'Math.max',
        'Math.Max',
      ),
      `BsonDocument[] change = [new("$set", new BsonDocument { ${sets.join(', ')} })];`,
    )
  } else {
    const also = [
      ...(touched.length > 0 ? [`["$set"] = new BsonDocument { ${touched.map((name) => `[${name}] = DateTime.UtcNow`).join(', ')} }`] : []),
      ...(info.version ? [`["$inc"] = new BsonDocument(${csString(info.version.column.name)}, 1)`] : []),
    ]
    let main: string
    if (method.query.kind === 'addItem') {
      if (list.by === 'id') result.push(`${list.item}.Id ??= ObjectId.GenerateNewId().ToString();`)
      main = `["$push"] = new BsonDocument(${path}, ${storedItem(list, list.item)})`
    } else if (list.by === 'id') {
      result.push(`if (!ObjectId.TryParse(${param.name}, out _)) return null;`)
      main = `["$pull"] = new BsonDocument(${path}, new BsonDocument("_id", new ObjectId(${param.name})))`
    } else main = `["$pull"] = new BsonDocument(${path}, ${storedItem(list, param.name)})`
    result.push(`var change = new BsonDocument { ${[main, ...also].join(', ')} };`)
  }
  return [
    ...result,
    `var filter = new BsonDocument { ${conditions.join(', ')} };`,
    `var changed = await db.ChangeAsync<${info.entity}>(${csString(info.entity)}, Collection, filter, change);`,
    `return ${updates(info) ? 'changed is null ? null : Loaded(changed)' : 'changed'};`,
  ]
}

export function tail(_context: Context, info: TableInfo): Line[] {
  if (!updates(info)) return []
  return [
    '',
    '    /// <summary>The same entity, with what it is stored as kept to tell its changes.</summary>',
    `    private static ${info.entity} Loaded(${info.entity} entity)`,
    '    {',
    '        Read.AddOrUpdate(entity, entity.ToBsonDocument());',
    '        return entity;',
    '    }',
  ]
}
