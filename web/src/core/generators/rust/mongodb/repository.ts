/**
 * The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
 * are not as they were read (so two people changing different fields do not undo each other, and the ones the entity
 * does not know are kept), and one item of a list is added or removed in the database.
 */
import { isObjectId } from '../../../schema/documents.ts'
import { columnOf, query, stored, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, listOf } from '../documents.ts'
import { memoryFill, type Method } from '../repositories.ts'
import { rsString, type RsUses } from '../rust.ts'
import { encoded } from './values.ts'

const changeable = (info: TableInfo, column: ColumnInfo) =>
  !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const updates = (info: TableInfo) => query(info, 'update') !== undefined && info.columns.some((column) => changeable(info, column))
const touchedBy = (info: TableInfo) => info.columns.filter(({ column }) => column.generated === 'onUpdateNow')

/** `"_id": of_object_id(&id)?` */
const equal = (column: ColumnInfo, value: string) => `${rsString(column.column.name)}: ${encoded(column.column.type, value)}`

function softCondition(info: TableInfo): string[] {
  if (!info.soft) return []
  return [`${rsString(info.soft.column.name)}: ${info.soft.column.type.kind === 'boolean' ? '{ "$ne": true }' : 'null'}`]
}

const doc = (conditions: string[]) => (conditions.length === 0 ? 'doc! {}' : `doc! { ${conditions.join(', ')} }`)

/** What a text that is not an identifier finds. */
const guards = (columns: ColumnInfo[], nothing: string) =>
  columns
    .filter((column) => isObjectId(column.column.type))
    .flatMap((column) => [`if !bson_values::is_object_id(&${column.field}) {`, `    return Ok(${nothing});`, '}'])

const key = (info: TableInfo) => info.key[0]
const sort = (info: TableInfo) => `doc! { ${rsString(key(info).column.name)}: 1 }`

export function body(context: Context, info: TableInfo, method: Method, uses: RsUses): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const given = () => doc([...columns.map((column) => equal(column, column.field)), ...soft])
  const collection = rsString(info.name)
  const entity = rsString(info.entity)
  const values = () => uses.add('crate::bson_values', 'mongodb::bson::doc')
  const entities = (documents: string) => `${documents}.iter().map(${info.entity}::from_document).collect::<Result<_, _>>()?`
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      values()
      return [
        ...guards(columns, 'None'),
        `let found = self.db.find_one(${collection}, ${given()}).await?;`,
        `Ok(found.as_ref().map(${info.entity}::from_document).transpose()?)`,
      ]
    case 'listByParent':
    case 'findAllBy':
      values()
      return [
        ...guards(columns, 'Vec::new()'),
        `let found = self.db.find(${collection}, ${given()}, ${sort(info)}, 0, 0).await?;`,
        `Ok(${entities('found')})`,
      ]
    case 'list':
      uses.add('mongodb::bson::doc')
      if (context.settings.paging === 'offset')
        return [
          `let total = self.db.count(${collection}, ${doc(soft)}).await?;`,
          'let found = if limit > 0 {',
          `    self.db.find(${collection}, ${doc(soft)}, ${sort(info)}, offset, limit).await?`,
          '} else {',
          '    Vec::new()',
          '};',
          `Ok(Page { items: ${entities('found')}, total, offset, limit })`,
        ]
      if (context.settings.paging === 'cursor') {
        values()
        return [
          `let mut filter = ${doc(soft)};`,
          'if let Some(after) = after {',
          `    filter.insert(${rsString(key(info).column.name)}, doc! { "$gt": ${encoded(key(info).column.type, 'after')} });`,
          '}',
          `let found = self.db.find(${collection}, filter, ${sort(info)}, 0, limit + 1).await?;`,
          `let mut items: Vec<${info.entity}> = ${entities('found')};`,
          'let more = items.len() as u64 > limit;',
          'items.truncate(limit as usize);',
          `let next = if more { items.last().map(|last| ${stored(`last.${key(info).field}`, key(info))}) } else { None };`,
          'Ok(CursorPage { items, next })',
        ]
      }
      return [`let found = self.db.find(${collection}, ${doc(soft)}, ${sort(info)}, 0, 0).await?;`, `Ok(${entities('found')})`]
    case 'insert':
      uses.add('crate::bson_values::Loaded')
      return [
        'let mut entity = entity;',
        // MongoDB fills nothing but the identifier
        ...info.columns.map(memoryFill).filter((line): line is string => line !== null),
        ...(identifiedLists(info).length > 0 ? ['entity.identify_items();'] : []),
        'let document = entity.to_document()?;',
        `self.db.insert(${entity}, ${collection}, &document).await?;`,
        'entity.loaded_document = Loaded(Some(document));',
        'Ok(entity)',
      ]
    case 'update': {
      if (!updates(info)) return ['// Nothing of it can change but its key', 'Ok(entity)']
      values()
      uses.add('crate::bson_values::Loaded')
      const fields = info.columns.filter((column) => changeable(info, column)).map((column) => rsString(column.column.name))
      const touched = touchedBy(info)
      return [
        'let mut entity = entity;',
        ...touched.map((column) => `entity.${column.field} = Some(chrono::Utc::now());`),
        ...(identifiedLists(info).length > 0 ? ['entity.identify_items();'] : []),
        'let now = entity.to_document()?;',
        `let ${touched.length > 0 ? 'mut ' : ''}changes = bson_values::changes(entity.loaded_document.0.as_ref(), &now, &[${fields.join(', ')}]);`,
        'if !changes.is_empty() {',
        ...touched.map(({ column }) => `    bson_values::also_set(&mut changes, &now, ${rsString(column.name)});`),
        `    self.db.update(${entity}, ${collection}, doc! { "_id": now.get("_id").cloned() }, changes).await?;`,
        '}',
        'entity.loaded_document = Loaded(Some(now));',
        'Ok(entity)',
      ]
    }
    case 'delete':
      values()
      return [
        `let ${key(info).field} = ${stored(`entity.${key(info).field}`, key(info))};`,
        `self.db.delete(${entity}, ${collection}, ${doc([equal(key(info), key(info).field)])}).await`,
      ]
    case 'addItem':
    case 'removeItem':
      values()
      return itemBody(info, method)
    default:
      return ['unimplemented!()']
  }
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(info: TableInfo, method: Method): string[] {
  const list = listOf(info, method.query)
  const [param] = list.params
  const path = rsString(list.column.column.name)
  const touched = touchedBy(info).map(({ column }) => `${rsString(column.name)}: mongodb::bson::DateTime::now()`)
  const version = info.version?.column.name
  const conditions = [equal(key(info), key(info).field), ...softCondition(info)]
  const result = guards([key(info)], 'None')
  const adds = method.query.kind === 'addItem'
  const rewrites = !adds && list.by === 'position'
  if (rewrites) {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    conditions.push(`${path}: { "$size": size as i64 }`)
    const kept = rsString(`$${list.column.column.name}`)
    const sets = [
      `${path}: { "$concatArrays": [head, tail] }`,
      ...touched,
      ...(version ? [`${rsString(version)}: { "$add": [${rsString(`$${version}`)}, 1] }`] : []),
    ]
    result.push(
      `let head = doc! { "$slice": [${kept}, position as i64] };`,
      `let tail = doc! { "$slice": [${kept}, position as i64 + 1, size.max(1) as i64] };`,
      `let change = vec![doc! { "$set": { ${sets.join(', ')} } }];`,
    )
  } else {
    let main: string
    if (adds) {
      if (list.by === 'id')
        result.push(
          `let mut ${list.item} = ${list.item};`,
          `${list.item}.id = ${list.item}.id.or_else(|| Some(mongodb::bson::oid::ObjectId::new().to_hex()));`,
        )
      main = `"$push": { ${path}: ${encoded(list.type, list.item, list.nested)} }`
    } else if (list.by === 'id') {
      result.push(`if !bson_values::is_object_id(&${param.name}) {`, '    return Ok(None);', '}')
      main = `"$pull": { ${path}: { "_id": bson_values::of_object_id(&${param.name})? } }`
    } else main = `"$pull": { ${path}: ${encoded(list.type, param.name, list.nested)} }`
    const also = [
      ...(touched.length > 0 ? [`"$set": { ${touched.join(', ')} }`] : []),
      ...(version ? [`"$inc": { ${rsString(version)}: 1 }`] : []),
    ]
    result.push(`let change = ${doc([main, ...also])};`)
  }
  return [
    ...result,
    `let changed = self.db.change(${rsString(info.entity)}, ${rsString(info.name)}, ${doc(conditions)}, change).await?;`,
    `Ok(changed.as_ref().map(${info.entity}::from_document).transpose()?)`,
  ]
}
