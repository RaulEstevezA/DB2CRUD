/**
 * Nested documents in a PHP project: arrays by the stored names of their fields, checked against their rules
 * (`App\Documents`), and the items of lists that operations add and remove one by one. Only strategies of document
 * databases (PhpOrm.documents) have them.
 */
import type { QueryDesign } from '../../../crud/types.ts'
import { itemKey, nestedFields } from '../../../schema/documents.ts'
import type { DbCheck, DbColumn, DbSchema, DbType } from '../../../schema/types.ts'
import { columnOf, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { fieldName, nullable, phpLiteral, phpString } from './php.ts'

const brackets = (items: string[]) => `[${items.join(', ')}]`

// Types

/** The type of a value as PHPDoc writes it: `list<array{sku: string, status?: string|null}>`. */
export function docTypeOf(context: Context, type: DbType): string {
  if (type.kind === 'array') return `list<${docTypeOf(context, type.items)}>`
  if (type.kind === 'json' && type.fields) {
    const fields = type.fields.map((field) => {
      const optional = field.nullable || field.default !== undefined
      const name = /^[A-Za-z_]\w*$/.test(field.name) ? field.name : phpString(field.name)
      const inner = docTypeOf(context, field.type)
      return `${name}${optional ? '?' : ''}: ${inner}${optional && inner !== 'mixed' ? '|null' : ''}`
    })
    return `array{${[...fields, '...'].join(', ')}}`
  }
  return context.orm.phpType(type)
}

// Rules

/** The limits of the CHECKs of a field, as settings of its rule. */
function limits(checks: DbCheck[]): string[] {
  return checks.flatMap(({ parsed }) => {
    if (!parsed) return []
    if (parsed.kind === 'in') return [`'values' => ${brackets(parsed.values.map((value) => phpLiteral(value)))}`]
    if (parsed.kind === 'compare') return [`'${{ '>=': 'min', '>': 'above', '<=': 'max', '<': 'below' }[parsed.op]}' => ${parsed.value}`]
    return parsed.op === '>=' ? [`'minLength' => ${parsed.value}`] : parsed.op === '<=' ? [`'maxLength' => ${parsed.value}`] : []
  })
}

function typeRule(schema: DbSchema, type: DbType): string[] {
  if (type.kind === 'array') return [`'items' => ${brackets(typeRule(schema, type.items))}`]
  if (type.kind === 'json' && type.fields)
    return [
      `'fields' => ${brackets(type.fields.filter((field) => field.name !== '_id').map((field) => `${phpString(field.name)} => ${fieldRule(schema, field)}`))}`,
    ]
  if (type.kind === 'enum') {
    const values = schema.enums.find((item) => item.name === type.name)?.values ?? []
    return [`'values' => ${brackets(values.map((value) => phpString(value)))}`]
  }
  return type.kind === 'text' && type.length !== undefined && !type.objectId ? [`'maxLength' => ${type.length}`] : []
}

function fieldRule(schema: DbSchema, field: DbColumn): string {
  return brackets([
    ...(field.nullable || field.default ? [] : [`'required' => true`]),
    ...typeRule(schema, field.type),
    ...limits(field.checks ?? []),
  ])
}

/** The rule of a column that holds documents or a list, as a PHP array; null for any other. */
export function documentRule(context: Context, type: DbType): string | null {
  if (!context.orm.documents || (type.kind !== 'array' && !nestedFields(type))) return null
  return brackets(typeRule(context.schema, type))
}

// Items of lists

export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  /** The PHP type of an item */
  php: string
  type: DbType
  /** How an item is told from the others: its identifier, its value or its position */
  by: 'id' | 'value' | 'position'
  params: { name: string; type: string }[]
}

export function listOf(context: Context, info: TableInfo, query: Pick<QueryDesign, 'columns' | 'name'>): ListInfo {
  const column = columnOf(info, query.columns[0])
  const type = (column.column.type as DbType & { kind: 'array' }).items
  const name = fieldName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.field === name) ? `${name}Item` : name
  const php = context.orm.phpType(type)
  const by = itemKey(type)
  const params =
    by === 'id'
      ? [{ name: `${item}Id`, type: 'string' }]
      : by === 'value'
        ? [{ name: item, type: php }]
        : [{ name: 'position', type: 'int' }]
  return { column, item, php, type, by, params }
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')

/** The type of a nested value in an array: null when the document may not have it. */
export const nestedPhp = (context: Context, field: DbColumn) =>
  field.nullable || field.default !== undefined ? nullable(context.orm.phpType(field.type)) : context.orm.phpType(field.type)
