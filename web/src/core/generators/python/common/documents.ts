/**
 * Nested documents in a Python project: a TypedDict per nested document, beside the entity that holds it;
 * `app/documents.py`, which checks them against their rules; and the items of lists that operations add and remove one
 * by one. Only strategies of document databases (PythonOrm.documents) have them.
 */
import type { QueryDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { singularize, splitWords } from '../../../model/naming.ts'
import { itemKey, nestedFields } from '../../../schema/documents.ts'
import type { DbCheck, DbColumn, DbSchema, DbType } from '../../../schema/types.ts'
import { lines } from '../../types.ts'
import { className, Imports, methodName, pyLiteral } from '../python.ts'
import type { ColumnInfo, Context, TableInfo } from './context.ts'

/** The type of a nested document. */
export interface NestedType {
  /** `OrderLine` */
  name: string
  fields: { column: DbColumn; nested: NestedType | null }[]
}

const isList = (type: DbType) => type.kind === 'array'

function nestedType(column: DbColumn, parent: string, taken: Set<string>): NestedType | null {
  const fields = nestedFields(column.type)
  if (!fields) return null
  const words = splitWords(column.name)
  const last = words[words.length - 1] ?? column.name
  let name = parent + className([...words.slice(0, -1), isList(column.type) ? singularize(last) : last].join(' '))
  while (taken.has(name)) name += 'Value'
  taken.add(name)
  return { name, fields: fields.map((field) => ({ column: field, nested: nestedType(field, name, taken) })) }
}

/** The types of the nested documents of a collection, by column. */
export function nestedTypes(columns: DbColumn[], entity: string): Map<string, NestedType> {
  const taken = new Set([entity])
  const result = new Map<string, NestedType>()
  for (const column of columns) {
    const nested = nestedType(column, entity, taken)
    if (nested) result.set(column.name, nested)
  }
  return result
}

/** A nested type and those inside it, the innermost first. */
export const innerFirst = (type: NestedType): NestedType[] => [
  ...type.fields.flatMap((field) => (field.nested ? innerFirst(field.nested) : [])),
  type,
]

// Rules

const key = (name: string) => JSON.stringify(name)
const braces = (items: string[]) => `{${items.join(', ')}}`

/** The limits of the CHECKs of a field, as settings of its rule. */
function limits(checks: DbCheck[]): string[] {
  return checks.flatMap(({ parsed }) => {
    if (!parsed) return []
    if (parsed.kind === 'in') return [`"values": [${parsed.values.map((value) => pyLiteral(value)).join(', ')}]`]
    if (parsed.kind === 'compare') return [`"${{ '>=': 'min', '>': 'above', '<=': 'max', '<': 'below' }[parsed.op]}": ${parsed.value}`]
    return parsed.op === '>=' ? [`"min_length": ${parsed.value}`] : parsed.op === '<=' ? [`"max_length": ${parsed.value}`] : []
  })
}

function typeRule(schema: DbSchema, type: DbType): string[] {
  if (type.kind === 'array') return [`"items": ${braces(typeRule(schema, type.items))}`]
  if (type.kind === 'json' && type.fields)
    return [
      `"fields": ${braces(type.fields.filter((field) => field.name !== '_id').map((field) => `${key(field.name)}: ${fieldRule(schema, field)}`))}`,
    ]
  if (type.kind === 'enum') {
    const values = schema.enums.find((item) => item.name === type.name)?.values ?? []
    return [`"values": [${values.map((value) => pyLiteral(value)).join(', ')}]`]
  }
  return type.kind === 'text' && type.length !== undefined && !type.objectId ? [`"max_length": ${type.length}`] : []
}

function fieldRule(schema: DbSchema, field: DbColumn): string {
  return braces([
    ...(field.nullable || field.default ? [] : ['"required": True']),
    ...typeRule(schema, field.type),
    ...limits(field.checks ?? []),
  ])
}

/** The columns that hold documents, or lists, with the rule of each. */
export function documentRules(context: Context, info: TableInfo): { column: ColumnInfo; rule: string }[] {
  if (!context.orm.documents) return []
  return info.columns
    .filter(({ column }) => column.type.kind === 'array' || (column.type.kind === 'json' && column.type.fields))
    .map((column) => ({ column, rule: braces(typeRule(context.schema, column.column.type)) }))
}

/** The lists of a collection whose documents have an identifier, which is made before they are stored. */
export const identifiedLists = (info: TableInfo) =>
  info.columns.filter(({ column }) => column.type.kind === 'array' && itemKey(column.type.items) === 'id')

export function documentsFile(context: Context): GeneratedFile | null {
  if (!context.orm.documents) return null
  return {
    path: 'app/documents.py',
    content: lines(
      '"""The documents inside others: their rules, what does not follow them, and the identifiers of those in lists."""',
      '',
      new Imports().from('typing', 'Any').from('bson', 'ObjectId').from('app.errors', 'FieldError').write('app'),
      '',
      'type Rule = dict[str, Any]',
      '"""What a value must be: the fields of a document, the items of a list, the values or limits of anything else."""',
      '',
      '',
      'def problems(value: Any, rule: Rule, path: str) -> list[FieldError]:',
      '    """What a value does not follow of its rule, each with the path of its field (`lines.0.quantity`). Fields the rules do not name are left alone."""',
      '    if value is None:',
      '        return [FieldError(path, "is required")] if rule.get("required") else []',
      '    errors: list[FieldError] = []',
      '    if "items" in rule:',
      '        if not isinstance(value, list):',
      '            return [FieldError(path, "must be a list")]',
      '        for index, item in enumerate(value):',
      '            errors += problems(item, rule["items"] | {"required": True}, f"{path}.{index}")',
      '    if "fields" in rule:',
      '        if not isinstance(value, dict):',
      '            return [FieldError(path, "must be a document")]',
      '        for name, field in rule["fields"].items():',
      '            errors += problems(value.get(name), field, f"{path}.{name}")',
      '    if "values" in rule and value not in rule["values"]:',
      '        errors.append(FieldError(path, "must be one of: " + ", ".join(str(item) for item in rule["values"])))',
      '    if "min" in rule and value < rule["min"]:',
      '        errors.append(FieldError(path, f"must be >= {rule[\'min\']}"))',
      '    if "above" in rule and value <= rule["above"]:',
      '        errors.append(FieldError(path, f"must be > {rule[\'above\']}"))',
      '    if "max" in rule and value > rule["max"]:',
      '        errors.append(FieldError(path, f"must be <= {rule[\'max\']}"))',
      '    if "below" in rule and value >= rule["below"]:',
      '        errors.append(FieldError(path, f"must be < {rule[\'below\']}"))',
      '    if "min_length" in rule and len(value) < rule["min_length"]:',
      '        errors.append(FieldError(path, f"must have >= {rule[\'min_length\']} characters"))',
      '    if "max_length" in rule and len(value) > rule["max_length"]:',
      '        errors.append(FieldError(path, f"is longer than {rule[\'max_length\']} characters"))',
      '    return errors',
      '',
      '',
      'def identify(items: list[Any] | None) -> None:',
      '    """Gives an identifier to the documents of a list that have none: MongoDB numbers only whole documents."""',
      '    for item in items or []:',
      '        if item.get("_id") is None:',
      '            item["_id"] = str(ObjectId())',
      '',
    ),
  }
}

// Items of lists

/** A list of a collection whose items are added and removed one by one. */
export interface ListInfo {
  column: ColumnInfo
  /** The name of one item in code: `line` */
  item: string
  type: DbType
  /** The column of one item, for its Python type */
  itemColumn: ColumnInfo
  /** How an item is told from the others: its `_id`, its value or its position */
  by: 'id' | 'value' | 'position'
}

export function listOf(info: TableInfo, query: Pick<QueryDesign, 'columns' | 'name'>): ListInfo {
  const column = info.columns.find((item) => item.column.name === query.columns[0])!
  const type = (column.column.type as DbType & { kind: 'array' }).items
  // The name of the item is that of the operation: `addLine` adds a `line`
  const name = methodName(query.name.replace(/^(add|remove)/, ''))
  const item = info.key.some((other) => other.attr === name) ? `${name}_item` : name
  return { column, item, type, itemColumn: { ...column, column: { ...column.column, type } }, by: itemKey(type) }
}

/** The parameters that say which item to remove. */
export function itemParams(list: ListInfo, type: (column: ColumnInfo) => string): { name: string; type: string }[] {
  if (list.by === 'id') return [{ name: `${list.item}_id`, type: 'str' }]
  return list.by === 'value' ? [{ name: list.item, type: type(list.itemColumn) }] : [{ name: 'position', type: 'int' }]
}
