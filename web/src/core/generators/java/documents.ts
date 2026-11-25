/**
 * Nested documents in a Java project: a class per nested document, inside the entity that holds it, the checks of their
 * rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
 * databases (JavaOrm.documents) have them.
 */
import type { QueryDesign } from '../../crud/types.ts'
import { singularize, splitWords } from '../../model/naming.ts'
import { isObjectId, itemKey, nestedFields } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'
import { capitalized, javaString, memberName, typeName, type JavaImports } from './java.ts'
import { columnOf, errorsPackage, javaType, type ColumnInfo, type Context, type TableInfo } from './context.ts'

/** The class of a nested document. */
export interface NestedClass {
  /** `Line` */
  name: string
  /** `Order.Line` */
  path: string
  fields: NestedField[]
  /** The classes inside it */
  classes: NestedClass[]
  /** Whether it is in a list, at any depth: lists are written whole, so it carries the fields its class does not know */
  listed: boolean
}

export interface NestedField {
  column: DbColumn
  prop: string
  java: string
  getter: string
  setter: string
  /** The class of the document it holds, or of each of its list */
  nested: NestedClass | null
}

/** Names an entity uses for something else */
const TAKEN = new Set([
  'Document',
  'Field',
  'FieldType',
  'Id',
  'Indexed',
  'CompoundIndex',
  'CompoundIndexes',
  'Instant',
  'List',
  'Object',
  'String',
  'BigDecimal',
  'UUID',
  'Boolean',
  'Integer',
  'Long',
  'Double',
  'Map',
])

function classNameOf(field: string, many: boolean, taken: Set<string>): string {
  const words = splitWords(field)
  const last = words[words.length - 1] ?? field
  let name = typeName([...words.slice(0, -1), many ? singularize(last) : last].join(' '))
  while (TAKEN.has(name) || taken.has(name)) name += 'Value'
  taken.add(name)
  return name
}

const listDepth = (type: DbType): number => (type.kind === 'array' ? 1 + listDepth(type.items) : 0)

/** The Java type of a value of a document, given the class of the documents it holds. */
function valueType(type: DbType, nested: string | null): string {
  switch (type.kind) {
    case 'array':
      return `List<${valueType(type.items, nested)}>`
    case 'json':
      return type.fields ? nested! : 'Object'
    case 'datetime':
      return 'Instant'
    // MongoDB has no dates without a time and no times of the day: their text
    case 'date':
    case 'time':
      return 'String'
    case 'unknown':
      return 'Object'
    default:
      return javaType(type).java
  }
}

function importsOf(type: DbType, entity: string): string[] {
  switch (type.kind) {
    case 'array':
      return ['java.util.List', ...importsOf(type.items, entity)]
    case 'json':
      return type.fields ? [entity] : []
    case 'datetime':
      return ['java.time.Instant']
    case 'date':
    case 'time':
    case 'unknown':
      return []
    default: {
      const { javaImport } = javaType(type)
      return javaImport ? [javaImport] : []
    }
  }
}

function nestedClass(column: DbColumn, parent: string, taken: Set<string>, inList = false): NestedClass | null {
  const fields = nestedFields(column.type)
  if (!fields) return null
  const listed = inList || listDepth(column.type) > 0
  const name = classNameOf(column.name, listDepth(column.type) > 0, taken)
  const path = `${parent}.${name}`
  // A class inside another cannot have the name of one that encloses it
  const inside = new Set(taken)
  const classes: NestedClass[] = []
  const used = new Set<string>()
  const written = fields.map((field): NestedField => {
    const nested = nestedClass(field, path, inside, listed)
    if (nested) classes.push(nested)
    let prop = field.name === '_id' ? 'id' : memberName(field.name)
    while (used.has(prop)) prop += '_'
    used.add(prop)
    return {
      column: field,
      prop,
      java: valueType(field.type, nested?.path ?? null),
      getter: `get${capitalized(prop)}`,
      setter: `set${capitalized(prop)}`,
      nested,
    }
  })
  return { name, path, fields: written, classes, listed }
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

/** The Java type of a column of a collection and what to import for it: several names, when it needs them. */
export function documentType(
  column: DbColumn,
  classes: Map<string, NestedClass>,
  entity: string,
): { java: string; javaImport: string | null } {
  const imports = [...new Set(importsOf(column.type, entity))]
  return { java: valueType(column.type, classes.get(column.name)?.path ?? null), javaImport: imports.length > 0 ? imports.join(',') : null }
}

/** Every import the nested classes of an entity need. */
export function nestedImports(classes: Iterable<NestedClass>): string[] {
  return [...classes]
    .flatMap((item) => [...item.fields.flatMap((field) => importsOf(field.column.type, '')), ...nestedImports(item.classes)])
    .filter(Boolean)
}

// Checks

const error = (path: string, message: string) => `errors.add(new FieldError(${path}, ${javaString(message)}));`

function limits(checks: DbCheck[], value: string, path: string, use: () => void): string[] {
  return checks.flatMap(({ parsed }) => {
    if (!parsed) return []
    if (parsed.kind === 'compare') {
      use()
      return [
        `if (${value} != null && !(new BigDecimal(String.valueOf(${value})).compareTo(new BigDecimal("${parsed.value}")) ${parsed.op} 0)) ${error(path, `must be ${parsed.op} ${parsed.value}`)}`,
      ]
    }
    if (parsed.kind === 'length')
      return [
        `if (${value} != null && !(String.valueOf(${value}).length() ${parsed.op} ${parsed.value})) ${error(path, `must have ${parsed.op} ${parsed.value} characters`)}`,
      ]
    return [
      `if (${value} != null && !List.of(${parsed.values.map((item) => javaString(String(item))).join(', ')}).contains(String.valueOf(${value}))) ${error(path, `must be one of: ${parsed.values.join(', ')}`)}`,
    ]
  })
}

/** The lines that check a value of a type; nested documents are checked by the method of their class. */
function typeChecks(type: DbType, value: string, path: string, nested: NestedClass | null, enums: DbEnum[], depth = 0): string[] {
  if (type.kind === 'array') {
    const index = `i${depth}`
    const inside = typeChecks(type.items, `${value}.get(${index})`, `${path} + "." + ${index}`, nested, enums, depth + 1)
    if (inside.length === 0) return []
    return [
      `if (${value} != null) {`,
      `    for (int ${index} = 0; ${index} < ${value}.size(); ${index}++) {`,
      ...inside.map((line) => `        ${line}`),
      '    }',
      '}',
    ]
  }
  if (type.kind === 'json' && type.fields && nested) {
    const call = `check${nested.path.split('.').slice(1).join('')}(${value}, ${path}, errors);`
    return depth > 0 ? [`if (${value} == null) ${error(path, 'is required')}`, `else ${call}`] : [`if (${value} != null) ${call}`]
  }
  if (type.kind === 'enum') {
    const values = enums.find((item) => item.name === type.name)?.values ?? []
    return [
      `if (${value} != null && !List.of(${values.map(javaString).join(', ')}).contains(${value})) ${error(path, `must be one of: ${values.join(', ')}`)}`,
    ]
  }
  if (type.kind === 'text' && type.length !== undefined && !isObjectId(type))
    return [`if (${value} != null && ${value}.length() > ${type.length}) ${error(path, `is longer than ${type.length} characters`)}`]
  return []
}

function checkMethods(context: Context, item: NestedClass, imports: JavaImports): string[][] {
  const body = item.fields
    .filter((field) => field.column.name !== '_id')
    .flatMap((field) => {
      const value = `value.${field.getter}()`
      const path = `path + ${javaString(`.${field.column.name}`)}`
      return [
        ...(field.column.nullable || field.column.default ? [] : [`if (${value} == null) ${error(path, 'is required')}`]),
        ...typeChecks(field.column.type, value, path, field.nested, context.schema.enums),
        ...limits(field.column.checks ?? [], value, path, () => imports.add('java.math.BigDecimal')),
      ]
    })
  if (body.some((line) => line.includes('List.of('))) imports.add('java.util.List')
  return [
    [
      `/** What a ${item.name} does not follow of its rules, each with the path of its field. */`,
      `private static void check${item.path.split('.').slice(1).join('')}(${item.path} value, String path, List<FieldError> errors) {`,
      ...body.map((line) => `    ${line}`),
      '}',
    ],
    ...item.classes.flatMap((inner) => checkMethods(context, inner, imports)),
  ]
}

/** The methods of a service that check the nested documents of its collection. */
export function documentCheckMethods(context: Context, info: TableInfo, imports: JavaImports): string[][] {
  const classes = [...info.nested.values()]
  if (classes.length === 0) return []
  imports.add('java.util.List', `${errorsPackage(context)}.FieldError`)
  return classes.flatMap((item) => checkMethods(context, item, imports))
}

/** The lines that check a column that holds documents or a list, as `value` of a map: cast to its type first. */
export function documentRules(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const type = column.column.type
  if (!context.orm.documents || (type.kind !== 'array' && !nestedFields(type))) return []
  const lines = typeChecks(
    type,
    'document',
    javaString(column.column.name),
    info.nested.get(column.column.name) ?? null,
    context.schema.enums,
  )
  if (lines.length === 0) return []
  return [
    ...(column.java.includes('<') ? ['@SuppressWarnings("unchecked")'] : []),
    `${column.java} document = (${column.java}) value;`,
    ...lines,
  ]
}

// Items of lists

export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The Java type of an item */
  java: string
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
  const java = valueType(type, nested?.path ?? null)
  const by = itemKey(type)
  const params =
    by === 'id'
      ? [{ name: `${item}Id`, type: 'String' }]
      : by === 'value'
        ? [{ name: item, type: java }]
        : [{ name: 'position', type: 'int' }]
  return { column, item, java, type, nested, by, params }
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')
