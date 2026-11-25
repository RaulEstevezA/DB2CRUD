/**
 * Nested documents in a Swift project: a struct per nested document, inside the entity that holds it, the checks of their
 * rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
 * databases (SwiftOrm.documents) have them.
 */
import type { QueryDesign } from '../../crud/types.ts'
import { singularize, splitWords } from '../../model/naming.ts'
import { isObjectId, itemKey, nestedFields } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'
import { columnOf, swType, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { memberName, swString, typeName } from './swift.ts'

/** The struct of a nested document. */
export interface NestedStruct {
  /** `Line` */
  name: string
  /** `Order.Line` */
  path: string
  fields: NestedField[]
  /** The structs inside it */
  structs: NestedStruct[]
}

export interface NestedField {
  column: DbColumn
  prop: string
  /** The name of the property without backticks, as an argument */
  key: string
  sw: string
  /** The struct of the document it holds, or of each of its list */
  nested: NestedStruct | null
}

/** A value nothing says the shape of: what a document has, kept as it is. */
export const FREE = 'BsonValue'

/** Names an entity uses for something else, or Swift keeps for itself */
const TAKEN = new Set(
  'String Int Double Float Bool Decimal Date Data UUID Array Optional Any Type Protocol Self Error Never Void Bson BsonValue BsonDocument Loaded'.split(
    ' ',
  ),
)

/** The Swift type of a value of a document, given the struct of the documents it holds. */
export function valueType(type: DbType, nested: string | null): { sw: string; comparable: boolean } {
  switch (type.kind) {
    case 'array':
      return { sw: `[${valueType(type.items, nested).sw}]`, comparable: false }
    case 'json':
      return { sw: type.fields ? nested! : FREE, comparable: false }
    case 'unknown':
      return { sw: FREE, comparable: false }
    // MongoDB has no dates without a time and no times of the day: their text
    case 'date':
    case 'time':
      return { sw: 'String', comparable: true }
    default:
      return swType(type)
  }
}

const listDepth = (type: DbType): number => (type.kind === 'array' ? 1 + listDepth(type.items) : 0)

function nestedStruct(column: DbColumn, parent: string, taken: Set<string>): NestedStruct | null {
  const fields = nestedFields(column.type)
  if (!fields) return null
  const words = splitWords(column.name)
  const last = words[words.length - 1] ?? column.name
  let name = typeName([...words.slice(0, -1), listDepth(column.type) > 0 ? singularize(last) : last].join(' '))
  while (TAKEN.has(name) || taken.has(name)) name += 'Value'
  taken.add(name)
  const path = `${parent}.${name}`
  // A struct inside another does not take the name of one that encloses it
  const inside = new Set(taken)
  const structs: NestedStruct[] = []
  const used = new Set<string>()
  const written = fields.map((field): NestedField => {
    const nested = nestedStruct(field, path, inside)
    if (nested) structs.push(nested)
    let prop = field.name === '_id' ? 'id' : memberName(field.name)
    while (used.has(prop)) prop = `${prop.replace(/`/g, '')}_`
    used.add(prop)
    return { column: field, prop, key: prop.replace(/`/g, ''), sw: valueType(field.type, nested?.path ?? null).sw, nested }
  })
  return { name, path, fields: written, structs }
}

/** The structs of the nested documents of a collection, by column. */
export function nestedStructs(columns: DbColumn[], entity: string): Map<string, NestedStruct> {
  const taken = new Set([entity])
  const result = new Map<string, NestedStruct>()
  for (const column of columns) {
    const nested = nestedStruct(column, entity, taken)
    if (nested) result.set(column.name, nested)
  }
  return result
}

// Checks

/** What is inside the quotes of a Swift string. */
const inside = (text: string) => swString(text).slice(1, -1)

const push = (path: string, message: string) => `errors.append(FieldError("${path}", ${swString(message)}))`

const number = (value: number | string) => {
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

function limits(field: NestedField, path: string): string[] {
  const asNumber = field.sw === 'Decimal' ? 'NSDecimalNumber(decimal: held).doubleValue' : 'Double(held)'
  const asText = field.sw === 'String' ? 'held' : '"\\(held)"'
  const rule = (condition: string, message: string) => [`if ${condition} {`, `    ${push(path, message)}`, '}']
  const numeric = ['integer', 'decimal', 'float'].includes(field.column.type.kind)
  return (field.column.checks ?? []).flatMap(({ parsed }: DbCheck) => {
    if (!parsed) return []
    if (parsed.kind === 'compare')
      return rule(`!(${asNumber} ${parsed.op} ${number(parsed.value)})`, `must be ${parsed.op} ${parsed.value}`)
    if (parsed.kind === 'length')
      return rule(`!(${asText}.count ${parsed.op} ${parsed.value})`, `must have ${parsed.op} ${parsed.value} characters`)
    const values = numeric ? parsed.values.map(number).join(', ') : parsed.values.map((item) => swString(String(item))).join(', ')
    return rule(`![${values}].contains(${numeric ? asNumber : asText})`, `must be one of: ${parsed.values.join(', ')}`)
  })
}

const checkName = (nested: NestedStruct) => `check${nested.path.replace(/\./g, '')}`

/** The lines that check a value of a type, known to be there; nested documents are checked by the function of their struct. */
function typeChecks(type: DbType, value: string, path: string, nested: NestedStruct | null, enums: DbEnum[], depth = 0): string[] {
  if (type.kind === 'array') {
    const items = typeChecks(type.items, `item${depth}`, `${path}.\\(i${depth})`, nested, enums, depth + 1)
    if (items.length === 0) return []
    return [`for (i${depth}, item${depth}) in ${value}.enumerated() {`, ...items.map((line) => `    ${line}`), '}']
  }
  if (type.kind === 'json' && type.fields && nested) return [`${checkName(nested)}(${value}, "${path}", &errors)`]
  if (type.kind === 'enum') {
    const values = enums.find((item) => item.name === type.name)?.values ?? []
    return [
      `if ![${values.map(swString).join(', ')}].contains(${value}) {`,
      `    ${push(path, `must be one of: ${values.join(', ')}`)}`,
      '}',
    ]
  }
  if (type.kind === 'text' && type.length !== undefined && !isObjectId(type))
    return [`if ${value}.count > ${type.length} {`, `    ${push(path, `is longer than ${type.length} characters`)}`, '}']
  return []
}

function checkFunctions(context: Context, item: NestedStruct): string[][] {
  const body = item.fields
    .filter((field) => field.column.name !== '_id')
    .flatMap((field) => {
      const path = `\\(path).${inside(field.column.name)}`
      const required = !field.column.nullable && !field.column.default
      const rules = [...typeChecks(field.column.type, 'held', path, field.nested, context.schema.enums), ...limits(field, path)]
      const missing = push(path, 'is required')
      if (rules.length === 0) return required ? [`if value.${field.prop} == nil { ${missing} }`] : []
      return [
        `if let held = value.${field.prop} {`,
        ...rules.map((line) => `    ${line}`),
        ...(required ? ['} else {', `    ${missing}`] : []),
        '}',
      ]
    })
  return [
    [
      `/// What a ${item.path} does not follow of its rules, each with the path of its field.`,
      `fileprivate func ${checkName(item)}(_ value: ${item.path}, _ path: String, _ errors: inout [FieldError]) {`,
      ...body.map((line) => `    ${line}`),
      '}',
    ],
    ...item.structs.flatMap((inner) => checkFunctions(context, inner)),
  ]
}

/** The functions of a service that check the nested documents of some columns. */
export const documentCheckFunctions = (context: Context, info: TableInfo, columns: string[]): string[][] =>
  columns.flatMap((name) => {
    const item = info.nested.get(name)
    return item ? checkFunctions(context, item) : []
  })

/** The lines that check a column that holds documents or a list, as `value`. */
export function documentRules(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const type = column.column.type
  if (!context.orm.documents || (type.kind !== 'array' && !nestedFields(type))) return []
  return typeChecks(type, 'value', inside(column.column.name), info.nested.get(column.column.name) ?? null, context.schema.enums)
}

/** The call that checks one document of a list before it is added. */
export const checkCall = (nested: NestedStruct, value: string, path: string) => `${checkName(nested)}(${value}, ${swString(path)}, &errors)`

// Items of lists

export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The Swift type of an item */
  sw: string
  type: DbType
  nested: NestedStruct | null
  /** How an item is told from the others: its identifier, its value or its position */
  by: 'id' | 'value' | 'position'
  params: { name: string; type: string }[]
}

export function listOf(info: TableInfo, query: Pick<QueryDesign, 'columns' | 'name'>): ListInfo {
  const column = columnOf(info, query.columns[0])
  const type = (column.column.type as DbType & { kind: 'array' }).items
  const nested = info.nested.get(column.column.name) ?? null
  const name = memberName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.prop === name) ? `${name.replace(/`/g, '')}Item` : name
  const { sw } = valueType(type, nested?.path ?? null)
  const by = itemKey(type)
  const params =
    by === 'id'
      ? [{ name: `${item.replace(/`/g, '')}Id`, type: 'String' }]
      : by === 'value'
        ? [{ name: item, type: sw }]
        : [{ name: 'position', type: 'Int' }]
  return { column, item, sw, type, nested, by, params }
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')
