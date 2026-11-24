/**
 * The Beanie repositories: documents become the project's plain entities, reads leave out documents marked as deleted,
 * pages go by offset or after a key, a change writes only the fields that are not as they were read (so two people
 * changing different fields do not undo each other, and the ones the models do not know are kept), and one item of a
 * list is added or removed in the database.
 */
import { isObjectId } from '../../../schema/documents.ts'
import type { Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import { query, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { listOf } from '../common/documents.ts'
import type { RepositoryMethod } from '../common/orm.ts'
import { identified, memoryFill } from '../common/repositories.ts'
import { documentClass, modelClass, modelsOf } from './models.ts'

const changeable = (info: TableInfo) =>
  info.columns.filter((column) => !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow')

const updates = (info: TableInfo) => query(info, 'update') !== undefined && changeable(info).length > 0
const touchedBy = (info: TableInfo) => info.columns.filter(({ column }) => column.generated === 'onUpdateNow')

/** `_entity` and `_document`: an entity of a document, and the other way round. */
export function beanieHelpers(_context: Context, info: TableInfo, imports: Imports): Line[] {
  const document = documentClass(info)
  imports.from('app.db', 'plain').from('app.models', document)
  const loads = updates(info)
  if (loads) imports.from('app.db', 'stored').from('weakref', 'WeakKeyDictionary').from('typing', 'Any')
  return [
    ...(loads
      ? [
          '',
          '',
          `_LOADED: WeakKeyDictionary[${info.entity}, dict[str, Any]] = WeakKeyDictionary()`,
          '"""What each entity was read as: a change writes only the fields that differ."""',
          '',
          `_FIELDS = (${changeable(info)
            .map((column) => `${pyLiteral(column.column.name)},`)
            .join(' ')})`,
          '"""The fields a change may write."""',
        ]
      : []),
    '',
    '',
    `def _document(entity: ${info.entity}) -> ${document}:`,
    `    """The document of a ${info.entity}."""`,
    `    return ${document}.model_validate(`,
    '        {',
    ...info.columns.map((column) => `            ${pyLiteral(column.column.name)}: entity.${column.attr},`),
    '        }',
    '    )',
    '',
    '',
    `def _entity(document: ${document}) -> ${info.entity}:`,
    `    """The ${info.entity} of a document; a field it does not have is None."""`,
    '    values = plain(document)',
    `    ${loads ? 'entity =' : 'return'} ${info.entity}(`,
    ...info.columns.map((column) => `        ${column.attr}=values.get(${pyLiteral(column.column.name)}),`),
    '    )',
    ...(loads ? ['    return _loaded(entity)'] : []),
    ...(loads
      ? [
          '',
          '',
          `def _loaded(entity: ${info.entity}) -> ${info.entity}:`,
          '    """The same entity, with what it is stored as kept to tell its changes."""',
          '    _LOADED[entity] = stored(_document(entity))',
          '    return entity',
        ]
      : []),
  ]
}

/** The value a field is looked up with: the identifiers of the database are not texts. */
function lookup(column: ColumnInfo, value: string, imports: Imports): string {
  if (!isObjectId(column.column.type)) return value
  imports.from('bson', 'ObjectId')
  return `ObjectId(${value})`
}

function filterOf(info: TableInfo, conditions: string[]): string {
  const soft = info.soft
    ? [`${pyLiteral(info.soft.column.name)}: ${info.soft.column.type.kind === 'boolean' ? '{"$ne": True}' : 'None'}`]
    : []
  return `{${[...conditions, ...soft].join(', ')}}`
}

const equal = (column: ColumnInfo, value: string, imports: Imports) => `${pyLiteral(column.column.name)}: ${lookup(column, value, imports)}`

/** A text that is not an identifier points to nothing. */
function guards(columns: ColumnInfo[], empty: string, imports: Imports): Line[] {
  const identifiers = columns.filter((column) => isObjectId(column.column.type))
  if (identifiers.length === 0) return []
  imports.from('bson', 'ObjectId')
  return identifiers.flatMap((column) => [`if not ObjectId.is_valid(${column.attr}):`, `    return ${empty}`])
}

/** A write, with a refusal of the database turned into a domain error. */
function write(info: TableInfo, action: Line[], imports: Imports): Line[] {
  imports.from('app.db', 'REFUSALS', 'refusal')
  return [
    'try:',
    ...action.map((line) => (typeof line === 'string' ? `    ${line}` : line)),
    'except REFUSALS as error:',
    `    raise refusal("${info.entity}", error) from error`,
  ]
}

const SESSION = 'session=self._db.session'

export function beanieBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: Imports): Line[] {
  const document = documentClass(info)
  imports.from('app.models', document)
  const columns = method.query.columns.map((name) => info.columns.find((column) => column.column.name === name)!)
  const matching = () =>
    filterOf(
      info,
      columns.map((column) => equal(column, column.attr, imports)),
    )
  const sort = `.sort([${info.key.map((column) => `(${pyLiteral(column.column.name)}, 1)`).join(', ')}])`
  const byKey = () => `{${info.key.map((column) => equal(column, `entity.${column.attr}`, imports)).join(', ')}}`
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        ...guards(columns, 'None', imports),
        `document = await ${document}.find_one(${matching()}, ${SESSION})`,
        'return None if document is None else _entity(document)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        ...guards(columns, '[]', imports),
        `return [_entity(document) for document in await ${document}.find(${matching()}, ${SESSION})${sort}.to_list()]`,
      ]
    case 'list': {
      const all = filterOf(info, [])
      if (context.settings.paging === 'offset')
        return [
          `documents = await ${document}.find(${all}, ${SESSION})${sort}.skip(offset).limit(limit).to_list()`,
          `total = await ${document}.find(${all}, ${SESSION}).count()`,
          'return Page(items=[_entity(document) for document in documents], total=total, offset=offset, limit=limit)',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const after = info.key.map((column, index) => {
          const same = info.key.slice(0, index).map((before, position) => equal(before, `after[${position}]`, imports))
          const greater = `${pyLiteral(column.column.name)}: {"$gt": ${lookup(column, `after[${index}]`, imports)}}`
          return `{${[...same, greater].join(', ')}}`
        })
        return [
          `conditions: dict[str, Any] = ${all}`,
          'if after is not None:',
          after.length === 1 ? `    conditions |= ${after[0]}` : `    conditions["$or"] = [${after.join(', ')}]`,
          `documents = await ${document}.find(conditions, ${SESSION})${sort}.limit(limit + 1).to_list()`,
          'items = [_entity(document) for document in documents[:limit]]',
          `return CursorPage(items=items, next=(${info.key.map((column) => `items[-1].${column.attr}`).join(', ')},) if len(documents) > limit else None)`,
        ]
      }
      return [`return [_entity(document) for document in await ${document}.find(${all}, ${SESSION})${sort}.to_list()]`]
    }
    case 'insert': {
      // MongoDB fills nothing but the identifier
      const fills = info.columns
        .filter((column) => column.column.name !== '_id')
        .map((column) => memoryFill(context, column, imports))
        .filter((line): line is string => typeof line === 'string')
      const [key] = info.key
      return [
        ...fills,
        ...identified(info, imports),
        ...write(info, ['document = _document(entity)', `await document.insert(${SESSION})`], imports),
        ...(isObjectId(key.column.type) ? [`entity.${key.attr} = str(document.id)`] : []),
        `return ${updates(info) ? '_loaded(entity)' : 'entity'}`,
      ]
    }
    case 'update': {
      if (!updates(info)) return ['# Nothing of it can change but its key', 'return entity']
      imports.from('app.db', 'changes', 'stored')
      const touched = touchedBy(info)
      if (touched.length > 0) imports.from('datetime', 'UTC', 'datetime')
      return [
        ...identified(info, imports),
        ...write(
          info,
          [
            'change = changes(_LOADED.get(entity, {}), stored(_document(entity)), _FIELDS)',
            'if change:',
            ...touched.flatMap((column) => [
              `    entity.${column.attr} = datetime.now(UTC)`,
              `    change.setdefault("$set", {})[${pyLiteral(column.column.name)}] = entity.${column.attr}`,
            ]),
            `    await ${document}.find_one(${byKey()}).update(change, ${SESSION})`,
          ],
          imports,
        ),
        'return _loaded(entity)',
      ]
    }
    case 'delete':
      return write(info, [`await ${document}.find_one(${byKey()}).delete(${SESSION})`], imports)
    case 'addItem':
    case 'removeItem':
      return itemBody(info, method, imports)
    default:
      return ['raise NotImplementedError']
  }
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(info: TableInfo, method: RepositoryMethod, imports: Imports): Line[] {
  const document = documentClass(info)
  const list = listOf(info, method.query)
  const name = list.column.column.name
  const path = pyLiteral(name)
  const adds = method.query.kind === 'addItem'
  const touched = touchedBy(info).map(({ column }) => `${pyLiteral(column.name)}: datetime.now(UTC)`)
  if (touched.length > 0) imports.from('datetime', 'UTC', 'datetime')
  imports.from('beanie', 'UpdateResponse')
  const version = info.version ? pyLiteral(info.version.column.name) : null
  const conditions = info.key.map((column) => equal(column, column.attr, imports))
  const nested = modelsOf(info).get(name)
  // An item as the list keeps it
  const stored = (value: string) => {
    if (nested && list.type.kind === 'json') {
      imports.from('app.db', 'stored').from('app.models', modelClass(nested))
      return `stored(${modelClass(nested)}.model_validate(${value}))`
    }
    if (isObjectId(list.type)) {
      imports.from('bson', 'ObjectId')
      return `ObjectId(${value})`
    }
    return value
  }
  const before: Line[] = guards(info.key, 'None', imports)
  let change: string
  if (!adds && list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    conditions.push(`${path}: {"$size": size}`)
    const list_ = pyLiteral(`$${name}`)
    const set = [
      `${path}: {"$concatArrays": [{"$slice": [${list_}, position]}, {"$slice": [${list_}, position + 1, size]}]}`,
      ...touched,
      ...(version ? [`${version}: {"$add": [${pyLiteral(`$${info.version!.column.name}`)}, 1]}`] : []),
    ]
    change = `[{"$set": {${set.join(', ')}}}]`
  } else {
    let action: string
    if (adds) {
      if (list.by === 'id') {
        imports.from('app.documents', 'identify')
        before.push(`identify([${list.item}])`)
      }
      action = `"$push": {${path}: ${stored(list.item)}}`
    } else if (list.by === 'id') {
      imports.from('bson', 'ObjectId')
      before.push(`if not ObjectId.is_valid(${list.item}_id):`, '    return None')
      action = `"$pull": {${path}: {"_id": ObjectId(${list.item}_id)}}`
    } else action = `"$pull": {${path}: ${stored(list.item)}}`
    change = `{${[
      action,
      ...(touched.length > 0 ? [`"$set": {${touched.join(', ')}}`] : []),
      ...(version ? [`"$inc": {${version}: 1}`] : []),
    ].join(', ')}}`
  }
  return [
    ...before,
    ...write(
      info,
      [
        `document = await ${document}.find_one(${filterOf(info, conditions)}).update(`,
        `    ${change},`,
        `    ${SESSION},`,
        '    response_type=UpdateResponse.NEW_DOCUMENT,',
        ')',
      ],
      imports,
    ),
    'return None if document is None else _entity(document)',
  ]
}
