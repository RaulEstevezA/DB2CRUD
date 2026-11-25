/**
 * Nested documents in a C# project: a class per nested document, inside the entity that holds it, the checks of their
 * rules in the services, and the items of lists that operations add and remove one by one. Only strategies of document
 * databases (CsharpOrm.documents) have them.
 */
import type { QueryDesign } from '../../crud/types.ts'
import { singularize, splitWords } from '../../model/naming.ts'
import { isObjectId, itemKey, nestedFields } from '../../schema/documents.ts'
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'
import { csString, localName, pascalName } from './csharp.ts'
import { columnOf, csType, type ColumnInfo, type Context, type TableInfo } from './context.ts'

/** The class of a nested document. */
export interface NestedClass {
  /** `LineDocument`: a class cannot have the name of a property beside it */
  name: string
  /** `Order.LineDocument` */
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
  /** The type without `?` */
  cs: string
  valueType: boolean
  optional: boolean
  propType: string
  /** The class of the document it holds, or of each of its list */
  nested: NestedClass | null
}

/** A value nothing says the shape of, as the driver has it. */
export const FREE = 'MongoDB.Bson.BsonValue'

const listDepth = (type: DbType): number => (type.kind === 'array' ? 1 + listDepth(type.items) : 0)

/** The C# type of a value of a document, given the class of the documents it holds. */
function valueType(type: DbType, nested: string | null): { cs: string; valueType: boolean } {
  switch (type.kind) {
    case 'array':
      return { cs: `List<${valueType(type.items, nested).cs}>`, valueType: false }
    case 'json':
      return { cs: type.fields ? nested! : FREE, valueType: false }
    case 'unknown':
      return { cs: FREE, valueType: false }
    // MongoDB keeps moments in UTC
    case 'datetime':
      return { cs: 'DateTime', valueType: true }
    // MongoDB has no dates without a time and no times of the day: their text
    case 'date':
    case 'time':
      return { cs: 'string', valueType: false }
    default:
      return csType(type, 'mongodb')
  }
}

function nestedClass(column: DbColumn, parent: string, taken: Set<string>, inList = false): NestedClass | null {
  const fields = nestedFields(column.type)
  if (!fields) return null
  const listed = inList || listDepth(column.type) > 0
  const words = splitWords(column.name)
  const last = words[words.length - 1] ?? column.name
  let name = `${pascalName([...words.slice(0, -1), listDepth(column.type) > 0 ? singularize(last) : last].join(' '))}Document`
  while (taken.has(name)) name += 'Value'
  taken.add(name)
  const path = `${parent}.${name}`
  const used = new Set<string>([name])
  const props = fields.map((field) => {
    let prop = field.name === '_id' ? 'Id' : pascalName(field.name)
    while (used.has(prop)) prop += 'Value'
    used.add(prop)
    return prop
  })
  // A class inside another has neither the name of one that encloses it nor that of a property beside it
  const inside = new Set([...taken, ...used])
  const classes: NestedClass[] = []
  const written = fields.map((field, index): NestedField => {
    const nested = nestedClass(field, path, inside, listed)
    if (nested) classes.push(nested)
    const type = valueType(field.type, nested?.path ?? null)
    const optional = field.nullable || field.default !== undefined || field.generated !== undefined
    return { column: field, prop: props[index], ...type, optional, propType: optional ? `${type.cs}?` : type.cs, nested }
  })
  return { name, path, fields: written, classes, listed }
}

/** The classes of the nested documents of a collection, by column. */
export function nestedClasses(columns: DbColumn[], entity: string): Map<string, NestedClass> {
  const taken = new Set([entity, ...columns.map((column) => pascalName(column.name))])
  const result = new Map<string, NestedClass>()
  for (const column of columns) {
    const nested = nestedClass(column, entity, taken)
    if (nested) result.set(column.name, nested)
  }
  return result
}

/** The C# type of a column of a collection. */
export const documentType = (column: DbColumn, classes: Map<string, NestedClass>) =>
  valueType(column.type, classes.get(column.name)?.path ?? null)

// Checks

const error = (path: string, message: string) => `errors.Add(new FieldError(${path}, ${csString(message)}));`

function limits(checks: DbCheck[], value: string, path: string): string[] {
  return checks.flatMap(({ parsed }, index) => {
    if (!parsed) return []
    const held = `held${index}`
    if (parsed.kind === 'compare')
      return [
        `if (${value} is { } ${held} && !(Convert.ToDecimal(${held}) ${parsed.op} ${parsed.value}m)) ${error(path, `must be ${parsed.op} ${parsed.value}`)}`,
      ]
    if (parsed.kind === 'length')
      return [
        `if (${value} is { } ${held} && !(${held}.ToString()!.Length ${parsed.op} ${parsed.value})) ${error(path, `must have ${parsed.op} ${parsed.value} characters`)}`,
      ]
    return [
      `if (${value} is { } ${held} && !new[] { ${parsed.values.map((item) => csString(String(item))).join(', ')} }.Contains(Convert.ToString(${held}, System.Globalization.CultureInfo.InvariantCulture))) ${error(path, `must be one of: ${parsed.values.join(', ')}`)}`,
    ]
  })
}

/** The method that checks a nested document. */
const checkName = (nested: NestedClass) =>
  `Check${nested.path
    .split('.')
    .slice(1)
    .join('')
    .replace(/Document/g, '')}`

/** The lines that check a value of a type; nested documents are checked by the method of their class. */
function typeChecks(type: DbType, value: string, path: string, nested: NestedClass | null, enums: DbEnum[], depth = 0): string[] {
  if (type.kind === 'array') {
    const index = `i${depth}`
    const inside = typeChecks(type.items, `${value}[${index}]`, `${path} + "." + ${index}`, nested, enums, depth + 1)
    if (inside.length === 0) return []
    return [
      `if (${value} is not null)`,
      '{',
      `    for (var ${index} = 0; ${index} < ${value}.Count; ${index}++)`,
      '    {',
      ...inside.map((line) => `        ${line}`),
      '    }',
      '}',
    ]
  }
  if (type.kind === 'json' && type.fields && nested) {
    const call = `${checkName(nested)}(${value}, ${path}, errors);`
    return depth > 0 ? [`if (${value} is null) ${error(path, 'is required')}`, `else ${call}`] : [`if (${value} is not null) ${call}`]
  }
  if (type.kind === 'enum') {
    const values = enums.find((item) => item.name === type.name)?.values ?? []
    return [
      `if (${value} is not null && !new[] { ${values.map(csString).join(', ')} }.Contains(${value})) ${error(path, `must be one of: ${values.join(', ')}`)}`,
    ]
  }
  if (type.kind === 'text' && type.length !== undefined && !isObjectId(type))
    return [`if (${value} is not null && ${value}.Length > ${type.length}) ${error(path, `is longer than ${type.length} characters`)}`]
  return []
}

function checkMethods(context: Context, item: NestedClass): string[][] {
  const body = item.fields
    .filter((field) => field.column.name !== '_id')
    .flatMap((field) => {
      const value = `value.${field.prop}`
      const path = `path + ${csString(`.${field.column.name}`)}`
      return [
        // A value type that is not nullable is always there
        ...(field.optional || field.valueType ? [] : [`if (${value} is null) ${error(path, 'is required')}`]),
        ...typeChecks(field.column.type, value, path, field.nested, context.schema.enums),
        ...limits(field.column.checks ?? [], value, path).map((line) =>
          // Each limit names what it holds
          line.replace(/\bheld(\d+)\b/g, `${localName(field.prop).replace('@', '')}$1`),
        ),
      ]
    })
  return [
    [
      `/// <summary>What a ${item.path} does not follow of its rules, each with the path of its field.</summary>`,
      `private static void ${checkName(item)}(${item.path} value, string path, List<FieldError> errors)`,
      '{',
      ...body.map((line) => `    ${line}`),
      '}',
    ],
    ...item.classes.flatMap((inner) => checkMethods(context, inner)),
  ]
}

/** The methods of a service that check the nested documents of its collection. */
export const documentCheckMethods = (context: Context, info: TableInfo): string[][] =>
  [...info.nested.values()].flatMap((item) => checkMethods(context, item))

/** The lines that check a column that holds documents or a list, as `value` of a dictionary: cast to its type first. */
export function documentRules(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const type = column.column.type
  if (!context.orm.documents || (type.kind !== 'array' && !nestedFields(type))) return []
  const lines = typeChecks(
    type,
    'document',
    csString(column.column.name),
    info.nested.get(column.column.name) ?? null,
    context.schema.enums,
  )
  return lines.length === 0 ? [] : [`var document = (${column.cs})value;`, ...lines]
}

/** The call that checks one document of a list before it is added. */
export const checkCall = (nested: NestedClass, value: string, path: string) => `${checkName(nested)}(${value}, ${csString(path)}, errors);`

// Items of lists

export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The C# type of an item */
  cs: string
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
  const name = localName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.local === name) ? `${name}Item` : name
  const { cs } = valueType(type, nested?.path ?? null)
  const by = itemKey(type)
  const params =
    by === 'id'
      ? [{ name: `${item}Id`, type: 'string' }]
      : by === 'value'
        ? [{ name: item, type: cs }]
        : [{ name: 'position', type: 'int' }]
  return { column, item, cs, type, nested, by, params }
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')
