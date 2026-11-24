/**
 * The Mongoose repositories, over the models of a connection and, when there is one, the session of a transaction:
 * documents become the project's plain entities (identifiers, exact decimals and bytes as text, numbers and buffers),
 * reads leave out documents marked as deleted, pages go by offset or after a key, and a change writes only the fields
 * that are not as they were read, so two people changing different fields do not undo each other.
 */
import type { Line } from '../../types.ts'
import { quote, type TsImports } from '../typescript.ts'
import { columnType, query, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { listOf } from '../common/documents.ts'
import type { RepositoryMethod } from '../common/orm.ts'
import { fieldKey, modelsModule } from './models.ts'

const changeable = (info: TableInfo, column: ColumnInfo) =>
  !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

/** A field of a document as code reads it: `document.name`, `document['a b']`. */
const access = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `document.${name}` : `document[${quote(name)}]`)

const pairs = (columns: ColumnInfo[], target: string) =>
  columns.map((column) => `    ${fieldKey(column.column.name)}: ${target}.${column.prop},`)

/** toEntity, storedValues and changesOf of a collection. */
export function mongooseHelpers(context: Context, info: TableInfo, imports: TsImports): Line[] {
  imports.from('src/database', 'plain').type(modelsModule(context), 'Stored')
  const changes = info.columns.filter((column) => changeable(info, column))
  const updates = query(info, 'update') !== undefined && changes.length > 0
  const result: Line[] = []
  if (updates)
    result.push(
      '/** The values each entity was read with, by the stored names of its fields: a change writes only those that differ. */',
      `const loaded = new WeakMap<${info.entity}, Record<string, string>>()`,
      '',
      `/** The fields of an entity a change may write. */`,
      `function changeable(entity: ${info.entity}): Stored {`,
      '  return {',
      ...pairs(changes, 'entity'),
      '  }',
      '}',
      '',
      '/** The same fields as text, to compare them later. */',
      `const snapshot = (entity: ${info.entity}): Record<string, string> =>`,
      '  Object.fromEntries(Object.entries(changeable(entity)).map(([name, value]) => [name, JSON.stringify(value ?? null)]))',
      '',
    )
  result.push(
    `/** The ${info.entity} of a document; a field it does not have is null. */`,
    `function toEntity(document: Stored): ${info.entity} {`,
    `  ${updates ? 'const entity =' : 'return'} Object.assign(new ${info.entity}(), {`,
    ...info.columns.map((column) => `    ${column.prop}: (plain(${access(column.column.name)}) ?? null) as ${columnType(column)},`),
    '  })',
    ...(updates ? ['  loaded.set(entity, snapshot(entity))', '  return entity'] : []),
    '}',
  )
  if (query(info, 'insert'))
    result.push(
      '',
      '/** The fields of a new document; those left empty are not stored, and take their default. */',
      `function storedValues(entity: ${info.entity}): Stored {`,
      '  const values: Stored = {',
      ...pairs(info.columns, 'entity'),
      '  }',
      '  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null))',
      '}',
    )
  if (updates) {
    const touched = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
    result.push(
      '',
      '/** What a change writes and what it removes: only the fields that are not as they were read. */',
      `function changesOf(entity: ${info.entity}): { $set: Stored; $unset: Stored } {`,
      '  const before = loaded.get(entity)',
      '  const $set: Stored = {}',
      '  const $unset: Stored = {}',
      '  for (const [name, value] of Object.entries(changeable(entity))) {',
      '    if (before?.[name] === JSON.stringify(value ?? null)) continue',
      "    if (value === undefined || value === null) $unset[name] = ''",
      '    else $set[name] = value',
      '  }',
      ...touched.map(
        (column) =>
          `  $set${/^[A-Za-z_$][\w$]*$/.test(column.column.name) ? `.${column.column.name}` : `[${quote(column.column.name)}]`} = new Date()`,
      ),
      '  return { $set, $unset }',
      '}',
    )
  }
  return result
}

/** The condition that leaves out documents marked as deleted: a field that is not there is null. */
function softCondition(info: TableInfo): string | null {
  if (!info.soft) return null
  const name = fieldKey(info.soft.column.name)
  return info.soft.column.type.kind === 'boolean' ? `${name}: { $ne: true }` : `${name}: null`
}

const filterOf = (conditions: (string | null)[]) => {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? `{ ${present.join(', ')} }` : '{}'
}

const equal = (column: ColumnInfo, value: string) => {
  const key = fieldKey(column.column.name)
  return key === value ? key : `${key}: ${value}`
}

/** A write, with a refusal of the database or of the schema turned into a domain error. */
function write(info: TableInfo, action: Line[], imports: TsImports): Line[] {
  imports.from('src/database', 'refusal')
  return [
    'try {',
    ...action.map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    '} catch (error) {',
    `  throw refusal('${info.entity}', error)`,
    '}',
  ]
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(info: TableInfo, method: RepositoryMethod, model: string, imports: TsImports): Line[] {
  const list = listOf(info, method.query)
  const name = fieldKey(list.column.column.name)
  const keys = info.key.map((column) => equal(column, column.prop))
  const guards = info.key
    .filter((column) => column.column.type.kind === 'text' && column.column.type.objectId)
    .map((column) => {
      imports.from('src/database', 'isObjectId')
      return `if (!isObjectId(${column.prop})) return null`
    })
  const touched = info.columns
    .filter(({ column }) => column.generated === 'onUpdateNow')
    .map(({ column }) => `${fieldKey(column.name)}: new Date()`)
  const version = info.version ? [`${fieldKey(info.version.column.name)}: 1`] : []
  const also = [
    ...(touched.length > 0 ? [`$set: { ${touched.join(', ')} }`] : []),
    ...(version.length > 0 ? [`$inc: { ${version.join(', ')} }`] : []),
  ]
  const [param] = list.params
  let filter = filterOf([...keys, softCondition(info)])
  let change: string
  if (method.query.kind === 'addItem') change = `{ ${[`$push: { ${name}: ${list.item} }`, ...also].join(', ')} }`
  else if (list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    filter = filterOf([...keys, softCondition(info), `${name}: { $size: size }`])
    const path = quote(`$${list.column.column.name}`)
    const set = [
      `${name}: { $concatArrays: [{ $slice: [${path}, ${param.name}] }, { $slice: [${path}, ${param.name} + 1, size] }] }`,
      ...touched,
      ...(info.version ? [`${fieldKey(info.version.column.name)}: { $add: [${quote(`$${info.version.column.name}`)}, 1] }`] : []),
    ]
    change = `[{ $set: { ${set.join(', ')} } }]`
  } else change = `{ ${[`$pull: { ${name}: ${list.by === 'id' ? `{ _id: ${param.name} }` : param.name} }`, ...also].join(', ')} }`
  return [
    ...guards,
    'let changed: Stored | null',
    ...write(
      info,
      [
        `changed = await ${model}`,
        `  .findOneAndUpdate(${filter}, ${change}, { returnDocument: 'after', runValidators: true, timestamps: false })`,
        '  .session(this.session)',
        '  .lean<Stored>()',
      ],
      imports,
    ),
    'return changed === null ? null : toEntity(changed)',
  ]
}

export function mongooseBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const model = `this.db.models.${info.attr}`
  const columns = method.query.columns.map((name) => info.columns.find((item) => item.column.name === name)!)
  const byParams = columns.map((column) => equal(column, column.prop))
  const soft = softCondition(info)
  const sort = `.sort({ ${info.key.map((column) => `${fieldKey(column.column.name)}: 1`).join(', ')} })`
  const session = '.session(this.session).lean<Stored>()'
  const many = '.session(this.session).lean<Stored[]>()'
  const key = filterOf(info.key.map((column) => equal(column, `entity.${column.prop}`)))
  // A text that is not an identifier points to nothing, and Mongoose would fail to make it one
  const identifiers = columns.filter((column) => column.column.type.kind === 'text' && column.column.type.objectId)
  const guard = (empty: string) => {
    if (identifiers.length === 0) return []
    imports.from('src/database', 'isObjectId')
    return identifiers.map((column) => `if (!isObjectId(${column.prop})) return ${empty}`)
  }
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        ...guard('null'),
        `const foundDocument = await ${model}.findOne(${filterOf([...byParams, soft])})${session}`,
        'return foundDocument === null ? null : toEntity(foundDocument)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [...guard('[]'), `return (await ${model}.find(${filterOf([...byParams, soft])})${sort}${many}).map(toEntity)`]
    case 'list': {
      const filter = filterOf([soft])
      if (context.settings.paging === 'offset')
        return [
          `const documents = await ${model}.find(${filter})${sort}.skip(offset).limit(limit)${many}`,
          `const total = await ${model}.countDocuments(${filter}).session(this.session)`,
          'return { items: documents.map(toEntity), total, offset, limit }',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const after = info.key.map(
          (column, index) =>
            `{ ${[...info.key.slice(0, index).map((before, position) => `${fieldKey(before.column.name)}: after[${position}]`), `${fieldKey(column.column.name)}: { $gt: after[${index}] }`].join(', ')} }`,
        )
        return [
          `const filter = after === null ? ${filter} : ${soft ? `{ $and: [${filter}, ${after.length === 1 ? after[0] : `{ $or: [${after.join(', ')}] }`}] }` : after.length === 1 ? after[0] : `{ $or: [${after.join(', ')}] }`}`,
          `const rows = (await ${model}.find(filter)${sort}.limit(limit + 1)${many}).map(toEntity)`,
          'const items = rows.slice(0, limit)',
          'const last = items[items.length - 1]',
          `return { items, next: rows.length > limit ? [${info.key.map((column) => `last.${column.prop}`).join(', ')}] : null }`,
        ]
      }
      return [`return (await ${model}.find(${filter})${sort}${many}).map(toEntity)`]
    }
    case 'insert':
      return write(
        info,
        [
          // The identifier and the defaults are read back into the entity
          `const [document] = await ${model}.create([storedValues(entity)], { session: this.session ?? undefined })`,
          'const stored = toEntity(document.toObject() as Stored)',
          ...(info.columns.some((column) => changeable(info, column)) && query(info, 'update')
            ? ['Object.assign(entity, stored)', 'loaded.set(entity, loaded.get(stored)!)', 'return entity']
            : ['return Object.assign(entity, stored)']),
        ],
        imports,
      )
    case 'update':
      if (!info.columns.some((column) => changeable(info, column))) return ['// Nothing of it can change but its key', 'return entity']
      return [
        ...write(
          info,
          [
            `await ${model}.updateOne(${key}, changesOf(entity), { session: this.session ?? undefined, runValidators: true, timestamps: false })`,
          ],
          imports,
        ),
        'loaded.set(entity, snapshot(entity))',
        'return entity',
      ]
    case 'addItem':
    case 'removeItem':
      return itemBody(info, method, model, imports)
    case 'delete':
      return write(info, [`await ${model}.deleteOne(${key}).session(this.session)`], imports)
    default:
      return ["throw new Error('not written')"]
  }
}
