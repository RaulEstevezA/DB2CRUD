/**
 * Nested documents in a Rust project: a struct per nested document, in the module of the entity that holds it, the checks
 * of their rules in the services, and the items of lists that operations add and remove one by one. Only strategies of
 * document databases (RustOrm.documents) have them.
 */
import type { QueryDesign } from '../../crud/types.ts'
import { singularize, splitWords } from '../../model/naming.ts'
import { isObjectId, itemKey, nestedFields } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'
import { columnOf, rsType, type ColumnInfo, type Context, type Crate, type TableInfo } from './context.ts'
import { rsString, snakeName, typeName } from './rust.ts'

/** The struct of a nested document. */
export interface NestedStruct {
  /** `OrderLine` */
  name: string
  /** `crate::entities::order::OrderLine` */
  path: string
  fields: NestedField[]
  /** The structs of the documents inside it */
  structs: NestedStruct[]
}

export interface NestedField {
  column: DbColumn
  field: string
  rs: string
  crate: Crate | null
  copy: boolean
  /** The struct of the document it holds, or of each of its list */
  nested: NestedStruct | null
}

/** A value nothing says the shape of, as the driver has it. */
export const FREE = 'mongodb::bson::Bson'

/** The Rust type of a value of a document, given the struct of the documents it holds. */
export function valueType(type: DbType, nested: string | null): { rs: string; crate: Crate | null; copy: boolean } {
  switch (type.kind) {
    case 'array': {
      const items = valueType(type.items, nested)
      return { rs: `Vec<${items.rs}>`, crate: items.crate, copy: false }
    }
    case 'json':
      return { rs: type.fields ? nested! : FREE, crate: null, copy: false }
    case 'unknown':
      return { rs: FREE, crate: null, copy: false }
    // MongoDB keeps moments in UTC
    case 'datetime':
      return { rs: 'chrono::DateTime<chrono::Utc>', crate: 'chrono', copy: true }
    // MongoDB has no dates without a time and no times of the day: their text
    case 'date':
    case 'time':
      return { rs: 'String', crate: null, copy: false }
    default:
      return rsType(type)
  }
}

const listDepth = (type: DbType): number => (type.kind === 'array' ? 1 + listDepth(type.items) : 0)

function nestedStruct(column: DbColumn, parent: string, module: string, taken: Set<string>): NestedStruct | null {
  const fields = nestedFields(column.type)
  if (!fields) return null
  const words = splitWords(column.name)
  const last = words[words.length - 1] ?? column.name
  let name = parent + typeName([...words.slice(0, -1), listDepth(column.type) > 0 ? singularize(last) : last].join(' ')).replace(/^_/, '')
  while (taken.has(name)) name += 'Value'
  taken.add(name)
  const structs: NestedStruct[] = []
  const used = new Set<string>()
  const written = fields.map((item): NestedField => {
    const nested = nestedStruct(item, name, module, taken)
    if (nested) structs.push(nested)
    let field = item.name === '_id' ? 'id' : snakeName(item.name)
    while (used.has(field)) field += '_'
    used.add(field)
    return { column: item, field, ...valueType(item.type, nested?.path ?? null), nested }
  })
  return { name, path: `${module}::${name}`, fields: written, structs }
}

/** The structs of the nested documents of a collection, by column. */
export function nestedStructs(columns: DbColumn[], entity: string, module: string): Map<string, NestedStruct> {
  const taken = new Set([entity])
  const result = new Map<string, NestedStruct>()
  for (const column of columns) {
    const nested = nestedStruct(column, entity, module, taken)
    if (nested) result.set(column.name, nested)
  }
  return result
}

/** Every crate the nested documents need. */
export const nestedCrates = (structs: Iterable<NestedStruct>): (Crate | null)[] =>
  [...structs].flatMap((item) => [...item.fields.map((field) => field.crate), ...nestedCrates(item.structs)])

// Checks

/** Where a value is, as the text of a format string: `lines`, `{path}.quantity`. */
const pathText = (text: string) => (text.includes('{') ? `&format!(${rsString(text)})` : rsString(text))
const escaped = (name: string) => name.replace(/\{/g, '{{').replace(/\}/g, '}}')

const push = (errors: string, path: string, message: string) => `${errors}.push(FieldError::new(${pathText(path)}, ${rsString(message)}));`

const number = (value: number | string) => {
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

function limits(field: NestedField, path: string): string[] {
  const asNumber = field.rs === 'rust_decimal::Decimal' ? 'f64::try_from(*held).unwrap_or(f64::NAN)' : '(*held as f64)'
  const asText = field.rs === 'String' ? 'held.as_str()' : 'held.to_string().as_str()'
  const rule = (condition: string, message: string) => [`if ${condition} {`, `    ${push('errors', path, message)}`, '}']
  const numeric = ['integer', 'decimal', 'float'].includes(field.column.type.kind)
  return (field.column.checks ?? []).flatMap(({ parsed }: DbCheck) => {
    if (!parsed) return []
    if (parsed.kind === 'compare')
      return rule(`!(${asNumber} ${parsed.op} ${number(parsed.value)})`, `must be ${parsed.op} ${parsed.value}`)
    if (parsed.kind === 'length')
      return rule(`!(${asText}.chars().count() ${parsed.op} ${parsed.value})`, `must have ${parsed.op} ${parsed.value} characters`)
    const values = numeric ? parsed.values.map(number).join(', ') : parsed.values.map((item) => rsString(String(item))).join(', ')
    return rule(`![${values}].contains(&${numeric ? asNumber : asText})`, `must be one of: ${parsed.values.join(', ')}`)
  })
}

const checkName = (nested: NestedStruct) => `check_${snakeName(nested.name).replace(/^r#/, '')}`

/** The lines that check a value of a type (a reference, known to be there); nested documents are checked by the function of their struct. */
function typeChecks(
  type: DbType,
  value: string,
  path: string,
  nested: NestedStruct | null,
  enums: DbEnum[],
  errors: string,
  depth = 0,
): string[] {
  if (type.kind === 'array') {
    const inside = typeChecks(type.items, `item${depth}`, `${path}.{i${depth}}`, nested, enums, errors, depth + 1)
    if (inside.length === 0) return []
    return [`for (i${depth}, item${depth}) in ${value}.iter().enumerate() {`, ...inside.map((line) => `    ${line}`), '}']
  }
  if (type.kind === 'json' && type.fields && nested)
    return [`${checkName(nested)}(${value}, ${pathText(path)}, ${errors === 'errors' ? 'errors' : '&mut errors'});`]
  const target = 'errors'
  if (type.kind === 'enum') {
    const values = enums.find((item) => item.name === type.name)?.values ?? []
    return [
      `if ![${values.map(rsString).join(', ')}].contains(&${value}.as_str()) {`,
      `    ${push(target, path, `must be one of: ${values.join(', ')}`)}`,
      '}',
    ]
  }
  if (type.kind === 'text' && type.length !== undefined && !isObjectId(type))
    return [`if ${value}.chars().count() > ${type.length} {`, `    ${push(target, path, `is longer than ${type.length} characters`)}`, '}']
  return []
}

function checkFunctions(context: Context, item: NestedStruct): string[][] {
  const body = item.fields
    .filter((field) => field.column.name !== '_id')
    .flatMap((field) => {
      const path = `{path}.${escaped(field.column.name)}`
      const required = !field.column.nullable && !field.column.default
      const rules = [...typeChecks(field.column.type, 'held', path, field.nested, context.schema.enums, 'errors'), ...limits(field, path)]
      const missing = push('errors', path, 'is required')
      if (rules.length === 0) return required ? [`if value.${field.field}.is_none() {`, `    ${missing}`, '}'] : []
      return [
        `if let Some(held) = &value.${field.field} {`,
        ...rules.map((line) => `    ${line}`),
        ...(required ? ['} else {', `    ${missing}`] : []),
        '}',
      ]
    })
  const param = (name: string) => (body.length > 0 ? name : `_${name}`)
  return [
    [
      `/// What a ${item.name} does not follow of its rules, each with the path of its field.`,
      `fn ${checkName(item)}(${param('value')}: &${item.path}, ${param('path')}: &str, ${param('errors')}: &mut Vec<FieldError>) {`,
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
  return typeChecks(
    type,
    'value',
    escaped(column.column.name),
    info.nested.get(column.column.name) ?? null,
    context.schema.enums,
    '&mut errors',
  )
}

/** The call that checks one document of a list before it is added. */
export const checkCall = (nested: NestedStruct, value: string, path: string) =>
  `${checkName(nested)}(&${value}, ${rsString(path)}, &mut errors);`

// Items of lists

export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The Rust type of an item */
  rs: string
  copy: boolean
  type: DbType
  nested: NestedStruct | null
  /** How an item is told from the others: its identifier, its value or its position */
  by: 'id' | 'value' | 'position'
  params: { name: string; type: string; copy: boolean }[]
}

export function listOf(info: TableInfo, query: Pick<QueryDesign, 'columns' | 'name'>): ListInfo {
  const column = columnOf(info, query.columns[0])
  const type = (column.column.type as DbType & { kind: 'array' }).items
  const nested = info.nested.get(column.column.name) ?? null
  const name = snakeName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.field === name) ? `${name.replace(/^r#/, '')}_item` : name
  const { rs, copy } = valueType(type, nested?.path ?? null)
  const by = itemKey(type)
  const params =
    by === 'id'
      ? [{ name: `${item.replace(/^r#/, '')}_id`, type: 'String', copy: false }]
      : by === 'value'
        ? [{ name: item, type: rs, copy }]
        : [{ name: 'position', type: 'usize', copy: true }]
  return { column, item, rs, copy, type, nested, by, params }
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')
