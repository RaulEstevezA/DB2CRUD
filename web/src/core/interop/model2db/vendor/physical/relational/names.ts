import { nameWords, toPascalCase, toSnakeCase } from '../../model/naming.ts'
import type { FieldDef } from '../../model/schema.ts'
import type { FieldDesign } from '../../design/types.ts'
import { columnName, joinNames } from '../naming.ts'
import type { BuildOptions, ColumnType, NamingOptions } from '../types.ts'

/** Names and small facts the relational build needs; no state. */

export const DEFAULT_LENGTH = 255

/** Column name of a field: the one the user wrote, the database name the input declares, or the field's. */
export function fieldColumn(field: FieldDef, decided: FieldDesign | undefined, options: BuildOptions): string {
  return decided?.column ?? field.serializedName ?? columnName(field.name, options.naming)
}

/** A column accepts NULL when the field may be null, or may be missing without a value to put instead. */
export function storesNull(field: FieldDef): boolean {
  return field.nullable || (field.optional && field.defaultValue === undefined && !field.generated)
}

/** A float without a size (TypeScript's `number`) used as a key is an integer. */
export function keyType(type: ColumnType): ColumnType {
  return type.kind === 'primitive' && type.name === 'float' && type.bits === undefined
    ? { kind: 'primitive', name: 'integer', bits: 64 }
    : type
}

/** Name of a column holding another table's key: `customer` + `id` → `customer_id`; a key that already
 * starts with the prefix is kept as it is (`customer` + `customer_id` → `customer_id`). */
export function keyColumnName(prefix: string, key: string, options: { naming: NamingOptions }): string {
  const prefixWords = nameWords(prefix)
  const keyWords = nameWords(key)
  if (keyWords.length > prefixWords.length && prefixWords.every((word, i) => keyWords[i] === word)) return joinNames([key], options.naming)
  return joinNames([prefix, key], options.naming)
}

/** Table of a list or map owned by a model: `Order.tags` → `order_tags`. */
export function ownedTableName(model: string, field: string, options: { naming: NamingOptions }): string {
  if (options.naming.tables === 'model') return `${model}${toPascalCase(field)}`
  return `${toSnakeCase(model)}_${toSnakeCase(field)}`
}

/** Width of a text column holding enum values. */
export function enumLength(values: (string | number)[]): number {
  const longest = Math.max(1, ...values.map((value) => String(value).length))
  return longest <= 20 ? 20 : longest <= 50 ? 50 : DEFAULT_LENGTH
}
