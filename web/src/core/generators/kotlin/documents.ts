/**
 * Nested documents in a Kotlin project: a data class per nested document, inside the entity that holds it, the checks of
 * their rules in the services, and the items of lists that operations add and remove one by one. Only strategies of
 * document databases (KotlinOrm.documents) have them.
 */
import type { QueryDesign } from '../../crud/types.ts'
import { singularize, splitWords } from '../../model/naming.ts'
import { isObjectId, itemKey, nestedFields } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'
import { columnOf, ktType, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { ktString, memberName, typeName } from './kotlin.ts'

/** The class of a nested document. */
export interface NestedClass {
  /** `Line` */
  name: string
  /** `Order.Line` */
  path: string
  fields: NestedField[]
  /** The classes inside it */
  classes: NestedClass[]
}

export interface NestedField {
  column: DbColumn
  prop: string
  kt: string
  /** The class of the document it holds, or of each of its list */
  nested: NestedClass | null
}

/** Names an entity uses for something else */
const TAKEN = new Set([
  'Any',
  'String',
  'List',
  'Int',
  'Long',
  'Double',
  'Boolean',
  'ByteArray',
  'Instant',
  'BigDecimal',
  'UUID',
  'ObjectId',
])

const listDepth = (type: DbType): number => (type.kind === 'array' ? 1 + listDepth(type.items) : 0)

/** The Kotlin type of a value of a document, given the class of the documents it holds. */
export function valueType(type: DbType, nested: string | null): string {
  switch (type.kind) {
    case 'array':
      return `List<${valueType(type.items, nested)}>`
    case 'json':
      return type.fields ? nested! : 'Any'
    case 'datetime':
      return 'Instant'
    // MongoDB has no dates without a time and no times of the day: their text
    case 'date':
    case 'time':
      return 'String'
    case 'unknown':
      return 'Any'
    default:
      return ktType(type, 'mongodb').kt
  }
}

function importsOf(type: DbType, entity: string): string[] {
  switch (type.kind) {
    case 'array':
      return importsOf(type.items, entity)
    case 'json':
      return type.fields && entity ? [entity] : []
    case 'datetime':
      return ['java.time.Instant']
    case 'date':
    case 'time':
    case 'unknown':
      return []
    default: {
      const { ktImport } = ktType(type, 'mongodb')
      return ktImport ? [ktImport] : []
    }
  }
}

function nestedClass(column: DbColumn, parent: string, taken: Set<string>): NestedClass | null {
  const fields = nestedFields(column.type)
  if (!fields) return null
  const words = splitWords(column.name)
  const last = words[words.length - 1] ?? column.name
  let name = typeName([...words.slice(0, -1), listDepth(column.type) > 0 ? singularize(last) : last].join(' '))
  while (TAKEN.has(name) || taken.has(name)) name += 'Value'
  taken.add(name)
  const path = `${parent}.${name}`
  // A class inside another cannot have the name of one that encloses it
  const inside = new Set(taken)
  const classes: NestedClass[] = []
  const used = new Set<string>()
  const written = fields.map((field): NestedField => {
    const nested = nestedClass(field, path, inside)
    if (nested) classes.push(nested)
    let prop = field.name === '_id' ? 'id' : memberName(field.name)
    while (used.has(prop)) prop += '_'
    used.add(prop)
    return { column: field, prop, kt: valueType(field.type, nested?.path ?? null), nested }
  })
  return { name, path, fields: written, classes }
}

/** The classes of the nested documents of a collection, by column. */
export function nestedClasses(columns: DbColumn[], entity: string): Map<string, NestedClass> {
  const taken = new Set([entity])
  const result = new Map<string, NestedClass>()
  for (const column of columns) {
    const nested = nestedClass(column, entity, taken)
    if (nested) result.set(column.name, nested)
  }
  return result
}

/** The Kotlin type of a column of a collection and what to import for it: several names, when it needs them. */
export function documentType(column: DbColumn, classes: Map<string, NestedClass>, entity: string): { kt: string; ktImport: string | null } {
  const imports = [...new Set(importsOf(column.type, entity))]
  return { kt: valueType(column.type, classes.get(column.name)?.path ?? null), ktImport: imports.length > 0 ? imports.join(',') : null }
}

/** Every import the nested classes of an entity need. */
export function nestedImports(classes: Iterable<NestedClass>): string[] {
  return [...classes].flatMap((item) => [
    ...item.fields.flatMap((field) => importsOf(field.column.type, '')),
    ...nestedImports(item.classes),
  ])
}

// Checks

const error = (path: string, message: string) => `errors += FieldError(${path}, ${ktString(message)})`
const number = (value: number) => (/[.eE]/.test(String(value)) ? String(value) : `${value}.0`)

function limits(checks: DbCheck[], value: string, path: string): string[] {
  return checks.flatMap(({ parsed }) => {
    if (!parsed) return []
    if (parsed.kind === 'compare')
      return [`if (!(${value}.toDouble() ${parsed.op} ${number(parsed.value)})) ${error(path, `must be ${parsed.op} ${parsed.value}`)}`]
    if (parsed.kind === 'length')
      return [
        `if (!(${value}.toString().length ${parsed.op} ${parsed.value})) ${error(path, `must have ${parsed.op} ${parsed.value} characters`)}`,
      ]
    return [
      `if (${value}.toString() !in listOf(${parsed.values.map((item) => ktString(String(item))).join(', ')})) ${error(path, `must be one of: ${parsed.values.join(', ')}`)}`,
    ]
  })
}

const checkName = (nested: NestedClass) => `check${nested.path.split('.').slice(1).join('')}`

/** The lines that check a value of a type, known to be there; nested documents are checked by the function of their class. */
function typeChecks(type: DbType, value: string, path: string, nested: NestedClass | null, enums: DbEnum[], depth = 0): string[] {
  if (type.kind === 'array') {
    const inside = typeChecks(type.items, `item${depth}`, `${path} + "." + i${depth}`, nested, enums, depth + 1)
    if (inside.length === 0) return []
    return [`${value}.forEachIndexed { i${depth}, item${depth} ->`, ...inside.map((line) => `    ${line}`), '}']
  }
  if (type.kind === 'json' && type.fields && nested) return [`${checkName(nested)}(${value}, ${path}, errors)`]
  if (type.kind === 'enum') {
    const values = enums.find((item) => item.name === type.name)?.values ?? []
    return [`if (${value} !in listOf(${values.map(ktString).join(', ')})) ${error(path, `must be one of: ${values.join(', ')}`)}`]
  }
  if (type.kind === 'text' && type.length !== undefined && !isObjectId(type))
    return [`if (${value}.length > ${type.length}) ${error(path, `is longer than ${type.length} characters`)}`]
  return []
}

function checkFunctions(context: Context, item: NestedClass): string[][] {
  const body = item.fields
    .filter((field) => field.column.name !== '_id')
    .flatMap((field) => {
      const path = `path + ${ktString(`.${field.column.name}`)}`
      const required = !field.column.nullable && !field.column.default
      const rules = [
        ...typeChecks(field.column.type, 'held', path, field.nested, context.schema.enums),
        ...limits(field.column.checks ?? [], 'held', path),
      ]
      if (rules.length === 0) return required ? [`if (value.${field.prop} == null) ${error(path, 'is required')}`] : []
      return [
        `value.${field.prop}.let { held ->`,
        ...(required
          ? [`    if (held == null) ${error(path, 'is required')}`, '    else {', ...rules.map((line) => `        ${line}`), '    }']
          : ['    if (held != null) {', ...rules.map((line) => `        ${line}`), '    }']),
        '}',
      ]
    })
  return [
    [
      `/** What a ${item.path} does not follow of its rules, each with the path of its field. */`,
      ...(body.length > 0 ? [] : ['@Suppress("UNUSED_PARAMETER")']),
      `private fun ${checkName(item)}(value: ${item.path}, path: String, errors: MutableList<FieldError>) {`,
      ...body.map((line) => `    ${line}`),
      '}',
    ],
    ...item.classes.flatMap((inner) => checkFunctions(context, inner)),
  ]
}

/** The functions of a service that check the nested documents of its collection. */
export const documentCheckFunctions = (context: Context, info: TableInfo): string[][] =>
  [...info.nested.values()].flatMap((item) => checkFunctions(context, item))

/** The lines that check a column that holds documents or a list, as `value` of a map: cast to its type first. */
export function documentRules(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const type = column.column.type
  if (!context.orm.documents || (type.kind !== 'array' && !nestedFields(type))) return []
  const lines = typeChecks(
    type,
    'document',
    ktString(column.column.name),
    info.nested.get(column.column.name) ?? null,
    context.schema.enums,
  )
  return lines.length === 0 ? [] : [`val document = value as ${column.kt}`, ...lines]
}

/** The call that checks one document of a list before it is added. */
export const checkCall = (nested: NestedClass, value: string, path: string) => `${checkName(nested)}(${value}, ${ktString(path)}, errors)`

// Items of lists

export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The Kotlin type of an item */
  kt: string
  type: DbType
  nested: NestedClass | null
  /** How an item is told from the others: its identifier, its value or its position */
  by: 'id' | 'value' | 'position'
  params: { name: string; type: string }[]
}

export function listOf(info: TableInfo, query: Pick<QueryDesign, 'columns' | 'name'>): ListInfo {
  const column = columnOf(info, query.columns[0])
  const type = (column.column.type as DbType & { kind: 'array' }).items
  const nested = info.nested.get(column.column.name) ?? null
  const name = memberName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.prop === name) ? `${name}Item` : name
  const kt = valueType(type, nested?.path ?? null)
  const by = itemKey(type)
  const params =
    by === 'id'
      ? [{ name: `${item}Id`, type: 'String' }]
      : by === 'value'
        ? [{ name: item, type: kt }]
        : [{ name: 'position', type: 'Int' }]
  return { column, item, kt, type, nested, by, params }
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')
