/**
 * How the matching compares names (matching.ts): by their words, whatever their convention, with plurals and the
 * usual suffixes of models left out; a suffix may also say which way a model goes.
 */
import { nameWords, singularize } from '../model/naming.ts'
import type { FieldDef, ModelDef, ModelSchema } from '../model/schema.ts'
import type { DbColumn, DbTable } from '../schema/types.ts'

/** Which way a model goes: both, only into the table (a request) or only out of it (a response). */
export type Direction = 'both' | 'input' | 'output'

const SUFFIX_DIRECTIONS: Record<string, Direction> = {
  entity: 'both',
  model: 'both',
  dto: 'both',
  record: 'both',
  request: 'input',
  input: 'input',
  command: 'input',
  response: 'output',
  output: 'output',
}
export const DIRECTIONS: Direction[] = ['both', 'input', 'output']

/** The words a model name is compared by (without its suffixes, the last one singular) and its direction. */
export function modelName(name: string): { words: string[]; direction: Direction } {
  const words = nameWords(name)
  let direction: Direction = 'both'
  while (words.length > 1 && SUFFIX_DIRECTIONS[words.at(-1)!]) {
    const found = SUFFIX_DIRECTIONS[words.pop()!]
    if (direction === 'both') direction = found
  }
  return { words: singularWords(words), direction }
}

export const singularWords = (words: string[]) => (words.length > 0 ? [...words.slice(0, -1), singularize(words.at(-1)!)] : words)
export const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((word, index) => word === b[index])
export const key = (words: string[]) => words.join(' ')

/** Whether the words of a model name are those of a table or of its entity. */
export function namesTable(words: string[], table: DbTable): boolean {
  return [table.name, ...(table.entity ? [table.entity] : [])].some((name) => key(singularWords(nameWords(name))) === key(words))
}

/** All fields of a model, with those of the models it extends first. */
export function fieldsOf(model: ModelDef, schema: ModelSchema, seen = new Set<string>()): FieldDef[] {
  seen.add(model.name)
  const inherited = (model.extends ?? []).flatMap((name) => {
    const parent = schema.models.find((item) => item.name === name)
    return parent && !seen.has(parent.name) ? fieldsOf(parent, schema, seen) : []
  })
  return [...inherited, ...model.fields]
}

/** The names a field answers to: its own, its name on the wire and its aliases. */
export const fieldNames = (field: FieldDef) => [
  field.name,
  ...(field.serializedName ? [field.serializedName] : []),
  ...(field.aliases ?? []),
]

/** The field a column comes from: the same name, or the same words in another convention (both exact). */
export function fieldFor(column: DbColumn, fields: FieldDef[], taken: Set<string>): { field: FieldDef; sameName: boolean } | null {
  const names = [column.name, ...(column.attribute ? [column.attribute] : [])]
  const free = fields.filter((field) => !taken.has(field.name))
  const exact = free.find((field) => fieldNames(field).some((name) => names.includes(name)))
  if (exact) return { field: exact, sameName: true }
  const words = names.map((name) => key(nameWords(name)))
  const close = free.find((field) => fieldNames(field).some((name) => words.includes(key(nameWords(name)))))
  return close ? { field: close, sameName: false } : null
}
