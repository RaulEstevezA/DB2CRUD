/**
 * The shape of the documents of a collection, as the constant `App\Documents` converts values with: what each field is
 * in MongoDB when PHP has another type for it (an identifier or an exact number is a text, a moment a DateTimeImmutable).
 */
import { isObjectId } from '../../../schema/documents.ts'
import type { DbType } from '../../../schema/types.ts'
import { phpString } from '../common/php.ts'
import type { TableInfo } from '../common/context.ts'

/** The shape of a value as a PHP literal, or null for one that is stored as it is. */
export function shapeOf(type: DbType): string | null {
  if (isObjectId(type)) return "'objectId'"
  switch (type.kind) {
    case 'decimal':
    case 'uuid':
    case 'datetime':
    case 'binary':
      return `'${type.kind}'`
    case 'integer':
      return type.bits === 64 ? "'long'" : "'int'"
    case 'float':
      return "'double'"
    case 'array': {
      const items = shapeOf(type.items)
      return items === null ? null : `['items' => ${items}]`
    }
    case 'json':
      return type.fields
        ? `['fields' => [${type.fields.map((field) => `${phpString(field.name)} => ${shapeOf(field.type) ?? 'null'}`).join(', ')}]]`
        : null
    default:
      return null
  }
}

/** A value as MongoDB stores it. */
export function stored(type: DbType, value: string): string {
  const shape = shapeOf(type)
  return shape === null ? value : `Documents::toBson(${value}, ${shape})`
}

/** The shape of every field of a collection, by its stored name. */
export const shapeLines = (info: TableInfo): string[] => [
  '    private const SHAPE = [',
  ...info.columns.map(({ column }) => `        ${phpString(column.name)} => ${shapeOf(column.type) ?? 'null'},`),
  '    ];',
]
