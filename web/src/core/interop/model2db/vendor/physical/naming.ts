import { nameWords, toSnakeCase } from '../model/naming.ts'
import type { StorageTarget } from '../design/types.ts'
import type { NamingOptions } from './types.ts'

/** Documents keep the field names of the model; tables follow the SQL convention; Redis keys are singular
 * (`order:42`). */
export const DEFAULT_NAMING: Record<StorageTarget, NamingOptions> = {
  relational: { tables: 'plural', columns: 'snake' },
  document: { tables: 'plural', columns: 'field' },
  keyvalue: { tables: 'singular', columns: 'snake' },
  widecolumn: { tables: 'plural', columns: 'snake' },
}

/** Plural of an English word, for table names: `order` → `orders`, `category` → `categories`. */
export function pluralize(word: string): string {
  if (word === '') return word
  const lower = word.toLowerCase()
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${word}es`
  if (/[^aeiou]y$/.test(lower)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

/** Table or collection name of a model: `OrderLine` → `order_lines`, `order_line` or `OrderLine`. */
export function tableName(model: string, naming: NamingOptions): string {
  if (naming.tables === 'model') return model
  const snake = toSnakeCase(model)
  if (naming.tables === 'singular') return snake
  const words = snake.split('_')
  words[words.length - 1] = pluralize(words[words.length - 1])
  return words.join('_')
}

/** Column name of a field: `createdAt` → `created_at`, or the field name as it is. */
export function columnName(field: string, naming: NamingOptions): string {
  return naming.columns === 'snake' ? toSnakeCase(field) : field
}

/** Joins name parts in the column convention: (`address`, `city`) → `address_city` or `addressCity`. */
export function joinNames(parts: string[], naming: NamingOptions): string {
  if (naming.columns === 'snake') return parts.map(toSnakeCase).join('_')
  const words = parts.flatMap(nameWords)
  return words.map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1))).join('')
}

/** A name not used yet in a set, with a number when needed: `id`, `id_2`. */
export function freeName(name: string, used: Set<string>): string {
  let candidate = name
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${name}_${i}`
  used.add(candidate.toLowerCase())
  return candidate
}

// Most databases limit identifiers to 63 (PostgreSQL) or 64 characters; constraint names stay below
const MAX_IDENTIFIER = 60

/** Name of a constraint or index: `fk_orders_customer_id`, shortened if it gets too long. */
export function constraintName(prefix: string, table: string, columns: string[]): string {
  const name = [prefix, table, ...columns].join('_')
  if (name.length <= MAX_IDENTIFIER) return name
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `${name.slice(0, MAX_IDENTIFIER - 9)}_${hash.toString(36).slice(0, 8)}`
}
