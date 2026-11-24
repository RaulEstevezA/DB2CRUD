/**
 * Nested documents in a TypeScript project: `src/documents.ts`, which checks them against their rules, the rules of
 * each collection, and the items of its lists that operations add and remove one by one.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { itemKey } from '../../../schema/documents.ts'
import type { DbCheck, DbColumn, DbSchema, DbType } from '../../../schema/types.ts'
import { lines } from '../../types.ts'
import { memberName, quote, tsLiteral } from '../typescript.ts'
import { columnOf, tsType, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import type { QueryDesign } from '../../../crud/types.ts'

const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name))

/** The limits of the CHECKs of a field, as settings of its rule. */
function limits(checks: DbCheck[]): string[] {
  return checks.flatMap(({ parsed }) => {
    if (!parsed) return []
    if (parsed.kind === 'in') return [`values: [${parsed.values.map((value) => tsLiteral(value)).join(', ')}]`]
    if (parsed.kind === 'compare') return [`${{ '>=': 'min', '>': 'above', '<=': 'max', '<': 'below' }[parsed.op]}: ${parsed.value}`]
    return parsed.op === '>=' ? [`minLength: ${parsed.value}`] : parsed.op === '<=' ? [`maxLength: ${parsed.value}`] : []
  })
}

function typeRule(schema: DbSchema, type: DbType): string[] {
  if (type.kind === 'array') return [`items: ${braces(typeRule(schema, type.items))}`]
  if (type.kind === 'json' && type.fields)
    return [
      `fields: ${braces(type.fields.filter((field) => field.name !== '_id').map((field) => `${key(field.name)}: ${fieldRule(schema, field)}`))}`,
    ]
  if (type.kind === 'enum') {
    const values = schema.enums.find((item) => item.name === type.name)?.values ?? []
    return [`values: [${values.map((value) => quote(value)).join(', ')}]`]
  }
  return type.kind === 'text' && type.length !== undefined && !type.objectId ? [`maxLength: ${type.length}`] : []
}

const braces = (items: string[]) => (items.length > 0 ? `{ ${items.join(', ')} }` : '{}')

function fieldRule(schema: DbSchema, field: DbColumn): string {
  return braces([
    ...(field.nullable || field.default ? [] : ['required: true']),
    ...typeRule(schema, field.type),
    ...limits(field.checks ?? []),
  ])
}

/** Whether a rule has something to check. */
const says = (rule: string[]) => /\b(required|values|min|max|above|below|minLength|maxLength|fields|items: \{ )/.test(rule.join())

/** The columns that hold documents, or lists, with the rule of each. */
export function documentRules(context: Context, info: TableInfo): { column: ColumnInfo; rule: string }[] {
  return info.columns
    .filter(({ column }) => column.type.kind === 'array' || (column.type.kind === 'json' && column.type.fields))
    .map((column) => ({ column, rule: typeRule(context.schema, column.column.type) }))
    .filter(({ rule }) => says(rule))
    .map(({ column, rule }) => ({ column, rule: braces(rule) }))
}

export const usesDocuments = (context: Context) => context.tables.some((info) => info.service && documentRules(context, info).length > 0)

export function documentsFile(context: Context): GeneratedFile | null {
  if (!usesDocuments(context)) return null
  return {
    path: 'src/documents.ts',
    content: lines(
      '/** The rules of the documents inside others, and what does not follow them. */',
      "import type { FieldError } from './errors.js'",
      '',
      '/** What a value must be: the fields of a document, the items of a list, the values or limits of anything else. */',
      'export interface Rule {',
      '  required?: boolean',
      '  fields?: Record<string, Rule>',
      '  items?: Rule',
      '  values?: readonly unknown[]',
      '  min?: number',
      '  above?: number',
      '  max?: number',
      '  below?: number',
      '  minLength?: number',
      '  maxLength?: number',
      '}',
      '',
      '/** What a value does not follow of its rule, each with the path of its field: `lines.0.quantity`. Fields the rules do not name are left alone. */',
      'export function problems(value: unknown, rule: Rule, path: string): FieldError[] {',
      "  if (value === null || value === undefined) return rule.required ? [{ field: path, message: 'is required' }] : []",
      '  const errors: FieldError[] = []',
      '  const wrong = (message: string) => errors.push({ field: path, message })',
      '  if (rule.items) {',
      "    if (!Array.isArray(value)) return [{ field: path, message: 'must be a list' }]",
      '    value.forEach((item, index) => errors.push(...problems(item, { ...rule.items, required: true }, `${path}.${index}`)))',
      '  }',
      '  if (rule.fields) {',
      "    if (typeof value !== 'object' || Array.isArray(value)) return [{ field: path, message: 'must be a document' }]",
      '    for (const [name, field] of Object.entries(rule.fields)) errors.push(...problems((value as Record<string, unknown>)[name], field, `${path}.${name}`))',
      '  }',
      "  if (rule.values && !rule.values.includes(value)) wrong(`must be one of: ${rule.values.join(', ')}`)",
      '  if (rule.min !== undefined && Number(value) < rule.min) wrong(`must be >= ${rule.min}`)',
      '  if (rule.above !== undefined && Number(value) <= rule.above) wrong(`must be > ${rule.above}`)',
      '  if (rule.max !== undefined && Number(value) > rule.max) wrong(`must be <= ${rule.max}`)',
      '  if (rule.below !== undefined && Number(value) >= rule.below) wrong(`must be < ${rule.below}`)',
      '  if (rule.minLength !== undefined && String(value).length < rule.minLength) wrong(`must have >= ${rule.minLength} characters`)',
      '  if (rule.maxLength !== undefined && String(value).length > rule.maxLength) wrong(`is longer than ${rule.maxLength} characters`)',
      '  return errors',
      '}',
      '',
    ),
  }
}

/** A list of a collection whose items are added and removed one by one. */
export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The type of an item */
  type: string
  /** How an item is told from the others: its `_id`, its value or its position */
  by: 'id' | 'value' | 'position'
  /** The parameters that say which one to remove */
  params: { name: string; type: string }[]
}

export function listOf(info: TableInfo, query: Pick<QueryDesign, 'columns' | 'name'>): ListInfo {
  const column = columnOf(info, query.columns[0])
  const type = column.column.type as DbType & { kind: 'array' }
  // The name of the item is that of the operation: `addLine` adds a `line`
  const name = memberName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.prop === name) ? `${name}Item` : name
  const by = itemKey(type.items)
  const params =
    by === 'id'
      ? [{ name: `${item}Id`, type: 'string' }]
      : by === 'value'
        ? [{ name: item, type: tsType(type.items) }]
        : [{ name: 'position', type: 'number' }]
  return { column, item, type: tsType(type.items), by, params }
}
