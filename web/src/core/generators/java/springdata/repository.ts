/**
 * The database repositories over a MongoTemplate: reads leave out documents marked as deleted, a change writes only the
 * fields that are not as they were read (so two people changing different fields do not undo each other, and the ones
 * the entity does not know are kept), and one item of a list is added or removed in the database.
 */
import type { Line } from '../../types.ts'
import { isObjectId } from '../../../schema/documents.ts'
import { javaString, type JavaImports } from '../java.ts'
import { columnOf, query, sqlRepositoryClass, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, listOf } from '../documents.ts'
import { memoryFill, type Method } from '../repositories.ts'

const CORE = 'org.springframework.data.mongodb.core'

const changeable = (info: TableInfo, column: ColumnInfo) =>
  !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const updates = (info: TableInfo) => query(info, 'update') !== undefined && info.columns.some((column) => changeable(info, column))

/** `Criteria.where("a").is(a).and("b").is(b)`, with the condition that leaves out documents marked as deleted. */
function criteria(conditions: { path: string; test: string }[], imports: JavaImports): string {
  imports.add(`${CORE}.query.Criteria`, `${CORE}.query.Query`)
  if (conditions.length === 0) return 'new Query()'
  const [first, ...others] = conditions
  return `Query.query(Criteria.where(${javaString(first.path)})${first.test}${others.map((item) => `.and(${javaString(item.path)})${item.test}`).join('')})`
}

function softCondition(info: TableInfo): { path: string; test: string }[] {
  if (!info.soft) return []
  return [{ path: info.soft.prop, test: info.soft.column.type.kind === 'boolean' ? '.ne(true)' : '.is(null)' }]
}

const equal = (column: ColumnInfo, value: string) => ({ path: column.prop, test: `.is(${value})` })

/** A write, with a refusal of the database turned into a ConflictException. */
function write(context: Context, info: TableInfo, action: string[], imports: JavaImports): string[] {
  imports.add('org.springframework.dao.DataAccessException', `${context.base}.Documents`)
  return [
    'try {',
    ...action.map((line) => `    ${line}`),
    '} catch (DataAccessException error) {',
    `    throw Documents.refusal("${info.entity}", error);`,
    '}',
  ]
}

export function head(_context: Context, info: TableInfo, imports: JavaImports): Line[] {
  imports.add(`${CORE}.MongoTemplate`)
  if (updates(info)) imports.add('java.util.Collections', 'java.util.List', 'java.util.Map', 'java.util.WeakHashMap', 'org.bson.Document')
  return [
    ...(updates(info)
      ? [
          '    /** The document each entity was read from: a change writes only the fields that differ */',
          `    private static final Map<${info.entity}, Document> LOADED = Collections.synchronizedMap(new WeakHashMap<>());`,
          '',
          '    /** The fields a change may write */',
          `    private static final List<String> FIELDS = List.of(${info.columns
            .filter((column) => changeable(info, column))
            .map((column) => javaString(column.column.name))
            .join(', ')});`,
          '',
        ]
      : []),
    '    private final MongoTemplate mongo;',
    '',
    `    public ${sqlRepositoryClass(info)}(MongoTemplate mongo) {`,
    '        this.mongo = mongo;',
    '    }',
  ]
}

const loaded = (info: TableInfo, expression: string) => (updates(info) ? `loaded(${expression})` : expression)
const eachLoaded = (info: TableInfo, expression: string) =>
  updates(info) ? `${expression}.stream().map(this::loaded).toList()` : expression

export function body(context: Context, info: TableInfo, method: Method, imports: JavaImports): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const type = `${info.entity}.class`
  const [key] = info.key
  const byKey = (value: string) => criteria([equal(key, value)], imports)
  const sorted = () => {
    imports.add('org.springframework.data.domain.Sort')
    return `.with(Sort.by(${info.key.map((column) => javaString(column.prop)).join(', ')}))`
  }
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `${info.entity} found = mongo.findOne(${criteria([...columns.map((column) => equal(column, column.prop)), ...soft], imports)}, ${type});`,
        `return Optional.ofNullable(${updates(info) ? 'found == null ? null : loaded(found)' : 'found'});`,
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        `return ${eachLoaded(info, `mongo.find(${criteria([...columns.map((column) => equal(column, column.prop)), ...soft], imports)}${sorted()}, ${type})`)};`,
      ]
    case 'list': {
      const all = criteria(soft, imports)
      if (context.settings.paging === 'offset') {
        imports.add('java.util.List')
        return [
          `List<${info.entity}> items = ${eachLoaded(info, `mongo.find(${all}${sorted()}.skip(offset).limit(limit), ${type})`)};`,
          `return new Page<>(items, mongo.count(${all}, ${type}), offset, limit);`,
        ]
      }
      if (context.settings.paging === 'cursor') {
        return [
          `Query query = ${all}${sorted()}.limit(limit + 1);`,
          `if (after != null) query.addCriteria(Criteria.where(${javaString(key.prop)}).gt(after.get(0)));`,
          `List<${info.entity}> rows = ${eachLoaded(info, `mongo.find(query, ${type})`)};`,
          `List<${info.entity}> items = rows.stream().limit(limit).toList();`,
          `return new CursorPage<>(items, rows.size() > limit ? List.of(items.get(items.size() - 1).${key.getter}()) : null);`,
        ]
      }
      return [`return ${eachLoaded(info, `mongo.find(${all}${sorted()}, ${type})`)};`]
    }
    case 'insert': {
      // MongoDB fills nothing but the identifier
      const fills = info.columns
        .filter((column) => column.column.name !== '_id')
        .map((column) => {
          const fill = memoryFill(column, imports)
          if (fill && column.javaImport) imports.add(column.javaImport)
          return fill
        })
        .filter((line): line is string => line !== null)
      return [
        ...fills,
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems();'] : []),
        ...write(context, info, ['mongo.insert(entity);'], imports),
        `return ${loaded(info, 'entity')};`,
      ]
    }
    case 'update': {
      if (!updates(info)) return ['// Nothing of it can change but its key', 'return entity;']
      imports.add(`${context.base}.Documents`, 'com.mongodb.client.model.Filters')
      const touched = info.columns
        .filter(({ column }) => column.generated === 'onUpdateNow')
        .map((column) => `entity.${column.setter}(${column.java}.now());`)
      for (const column of info.columns) if (column.column.generated === 'onUpdateNow' && column.javaImport) imports.add(column.javaImport)
      const also = info.columns.filter(({ column }) => column.generated === 'onUpdateNow').map((column) => javaString(column.column.name))
      return [
        ...touched,
        ...(identifiedLists(info).length > 0 ? ['entity.identifyItems();'] : []),
        'Document now = Documents.of(mongo, entity);',
        `Document changes = Documents.changes(LOADED.get(entity), now, FIELDS);`,
        ...(also.length > 0
          ? [
              `if (!changes.isEmpty()) ((Document) changes.computeIfAbsent("$set", (name) -> new Document())).append(${also[0]}, now.get(${also[0]}));`,
            ]
          : []),
        ...write(
          context,
          info,
          [
            `if (!changes.isEmpty()) mongo.execute(${type}, (collection) -> collection.updateOne(Filters.eq("_id", now.get("_id")), changes));`,
          ],
          imports,
        ),
        'return loaded(entity);',
      ]
    }
    case 'delete':
      return write(context, info, [`mongo.remove(${byKey(`entity.${key.getter}()`)}, ${type});`], imports)
    case 'addItem':
    case 'removeItem':
      return itemBody(context, info, method, imports)
    default:
      return ['throw new UnsupportedOperationException();']
  }
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(context: Context, info: TableInfo, method: Method, imports: JavaImports): string[] {
  const list = listOf(info, method.query)
  const [key] = info.key
  const path = javaString(list.column.column.name)
  const objectKey = isObjectId(key.column.type)
  imports.add(
    'org.bson.Document',
    'com.mongodb.client.model.FindOneAndUpdateOptions',
    'com.mongodb.client.model.ReturnDocument',
    'java.util.Optional',
  )
  if (objectKey || list.by === 'id') imports.add('org.bson.types.ObjectId')
  const touched = info.columns
    .filter(({ column }) => column.generated === 'onUpdateNow')
    .map((column) => `.append(${javaString(column.column.name)}, new java.util.Date())`)
  const filter = [
    `new Document("_id", ${objectKey ? `new ObjectId(${key.prop})` : key.prop})`,
    ...(info.soft
      ? [
          `.append(${javaString(info.soft.column.name)}, ${info.soft.column.type.kind === 'boolean' ? 'new Document("$ne", true)' : 'null'})`,
        ]
      : []),
  ]
  const result: string[] = objectKey ? [`if (!ObjectId.isValid(${key.prop})) return Optional.empty();`] : []
  const [param] = list.params
  if (method.query.kind === 'removeItem' && list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    filter.push(`.append(${path}, new Document("$size", size))`)
    imports.add('java.util.List')
    const stored = javaString(`$${list.column.column.name}`)
    result.push(
      `Document head = new Document("$slice", List.of(${stored}, position));`,
      `Document tail = new Document("$slice", List.of(${stored}, position + 1, Math.max(size, 1)));`,
    )
    const version = info.version
      ? `.append(${javaString(info.version.column.name)}, new Document("$add", List.of(${javaString(`$${info.version.column.name}`)}, 1)))`
      : ''
    result.push(
      `List<Document> change = List.of(new Document("$set", new Document(${path}, new Document("$concatArrays", List.of(head, tail)))${touched.join('')}${version}));`,
    )
  } else {
    const also = [
      ...(touched.length > 0 ? [`.append("$set", new Document()${touched.join('')})`] : []),
      ...(info.version ? [`.append("$inc", new Document(${javaString(info.version.column.name)}, 1))`] : []),
    ].join('')
    if (method.query.kind === 'addItem') {
      if (list.by === 'id') result.push(`if (${list.item}.getId() == null) ${list.item}.setId(new ObjectId().toHexString());`)
      result.push(
        `Document change = new Document("$push", new Document(${path}, ${storedItem(context, list, list.item, imports)}))${also};`,
      )
    } else if (list.by === 'id') {
      result.push(`if (!ObjectId.isValid(${param.name})) return Optional.empty();`)
      result.push(
        `Document change = new Document("$pull", new Document(${path}, new Document("_id", new ObjectId(${param.name}))))${also};`,
      )
    } else
      result.push(
        `Document change = new Document("$pull", new Document(${path}, ${storedItem(context, list, param.name, imports)}))${also};`,
      )
  }
  result.push(
    `Document filter = ${filter.join('')};`,
    'FindOneAndUpdateOptions after = new FindOneAndUpdateOptions().returnDocument(ReturnDocument.AFTER);',
    'Document changed;',
    ...write(
      context,
      info,
      [`changed = mongo.execute(${info.entity}.class, (collection) -> collection.findOneAndUpdate(filter, change, after));`],
      imports,
    ),
    `return Optional.ofNullable(changed).map((document) -> ${loaded(info, `mongo.getConverter().read(${info.entity}.class, document)`)});`,
  )
  return result
}

/** An item as the list keeps it. */
function storedItem(context: Context, list: ReturnType<typeof listOf>, value: string, imports: JavaImports): string {
  if (list.nested && list.type.kind === 'json') {
    imports.add(`${context.base}.Documents`)
    return `Documents.of(mongo, ${value})`
  }
  if (isObjectId(list.type)) {
    imports.add('org.bson.types.ObjectId')
    return `new ObjectId(${value})`
  }
  return list.type.kind === 'decimal' ? `new org.bson.types.Decimal128(${value})` : `mongo.getConverter().convertToMongoType(${value})`
}

export function tail(_context: Context, info: TableInfo, imports: JavaImports): Line[] {
  if (!updates(info)) return []
  imports.add(`${_context.base}.Documents`)
  return [
    '',
    '    /** The same entity, with what it is stored as kept to tell its changes. */',
    `    private ${info.entity} loaded(${info.entity} entity) {`,
    '        LOADED.put(entity, Documents.of(mongo, entity));',
    '        return entity;',
    '    }',
  ]
}
