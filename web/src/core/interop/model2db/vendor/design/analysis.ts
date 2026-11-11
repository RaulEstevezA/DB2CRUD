import { nameWords, singularize } from '../model/naming.ts'
import { allFields, findModel, modelOf, type FieldDef, type ModelDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import { declaresKey } from './hints.ts'

/** Facts about a model schema that every proposal reads: who uses each model, which fields identify a
 * model, and what shape each field has. No decisions here. */

export interface Usage {
  from: string
  field: string
  /** Through a list or a map */
  many: boolean
}

export interface SchemaContext {
  schema: ModelSchema
  /** Fields of other models (or the same one) whose type leads to each model */
  usages: Map<string, Usage[]>
  /** Models named in some `extends` */
  parents: Set<string>
}

export function analyze(schema: ModelSchema): SchemaContext {
  const usages = new Map<string, Usage[]>()
  const parents = new Set<string>()
  for (const model of schema.models) {
    for (const parent of model.extends ?? []) parents.add(parent)
    for (const field of model.fields) {
      const target = modelOf(field.type)
      if (!target || !findModel(schema, target)) continue
      const list = usages.get(target) ?? []
      list.push({ from: model.name, field: field.name, many: field.type.kind !== 'model' })
      usages.set(target, list)
    }
  }
  return { schema, usages, parents }
}

/** Not used as the type of any field: a model stored on its own unless the user leaves it out. */
export function isTopLevel(context: SchemaContext, model: string): boolean {
  return (context.usages.get(model) ?? []).every((usage) => usage.from === model)
}

/** Only used as a parent of other models (a base class): its fields go into its children's tables. */
export function isParentOnly(context: SchemaContext, model: string): boolean {
  return context.parents.has(model) && isTopLevel(context, model)
}

/** Fields of other models that also use `target`, apart from `from.field`. */
export function otherUsages(context: SchemaContext, target: string, from: string, field: string): Usage[] {
  return (context.usages.get(target) ?? []).filter((usage) => !(usage.from === from && usage.field === field))
}

// ---------- Keys ----------

const KEY_TYPES = new Set(['integer', 'uuid', 'string'])

/** A field that could be a primary key: a non-null integer, UUID or text. A number without a size
 * (TypeScript's `number`) counts as an integer: the key column is written as one. */
export function keyable(field: FieldDef): boolean {
  const type = field.type
  if (type.kind !== 'primitive' || field.nullable) return false
  return KEY_TYPES.has(type.name) || (type.name === 'float' && type.bits === undefined)
}

/** Fields named like the model's identifier: `id`, `orderId`, `order_id`. */
function namedKey(model: ModelDef, field: FieldDef): boolean {
  const words = nameWords(field.name)
  if (words.length === 1 && (words[0] === 'id' || words[0] === 'uuid')) return true
  const modelWords = nameWords(model.name)
  return words.length === modelWords.length + 1 && words[words.length - 1] === 'id' && modelWords.every((word, i) => words[i] === word)
}

// Values that usually identify a row when there is no id: worth asking about, never assumed
const NATURAL_KEYS = new Set(['code', 'sku', 'slug', 'key', 'isbn', 'username', 'email', 'number', 'reference', 'handle'])

/** `sku`, `code`, or the model's own code (`productCode`, `invoiceNumber`); not `zipCode`. */
export function naturalKey(model: ModelDef, field: FieldDef): boolean {
  const words = nameWords(field.name)
  if (!NATURAL_KEYS.has(words[words.length - 1])) return false
  if (words.length === 1) return true
  const modelWords = nameWords(model.name)
  return words.length === modelWords.length + 1 && modelWords.every((word, i) => words[i] === word)
}

/** The key field the model declares or is obviously named for, if any. */
export function keyField(model: ModelDef, fields: FieldDef[]): { field: FieldDef; declared: boolean } | null {
  const declared = fields.find(declaresKey)
  if (declared) return { field: declared, declared: true }
  const named = fields.find((field) => namedKey(model, field) && keyable(field))
  return named ? { field: named, declared: false } : null
}

export function hasKey(context: SchemaContext, name: string): boolean {
  const model = findModel(context.schema, name)
  return model !== undefined && keyField(model, allFields(context.schema, model)) !== null
}

// ---------- Shapes of fields ----------

/** What a field holds, as far as storing it is concerned. Scalars and enums have no shape: they are columns. */
export type Shape =
  | { kind: 'model'; target: string }
  | { kind: 'models'; target: string }
  | { kind: 'values' }
  | { kind: 'map'; plain: boolean }
  | { kind: 'free'; unknown: boolean }

export function shapeOf(context: SchemaContext, type: TypeRef): Shape | null {
  if (type.kind === 'model')
    return findModel(context.schema, type.name) ? { kind: 'model', target: type.name } : { kind: 'free', unknown: true }
  if (type.kind === 'unknown') return { kind: 'free', unknown: true }
  if (type.kind === 'primitive') return type.name === 'any' ? { kind: 'free', unknown: false } : null
  if (type.kind === 'enum') return null
  if (type.kind === 'map') return { kind: 'map', plain: type.value.kind === 'primitive' || type.value.kind === 'enum' }
  const items = type.items
  if (items.kind === 'model' && findModel(context.schema, items.name)) return { kind: 'models', target: items.name }
  if (items.kind === 'primitive' || items.kind === 'enum')
    return items.kind === 'primitive' && items.name === 'any' ? { kind: 'free', unknown: false } : { kind: 'values' }
  return { kind: 'free', unknown: items.kind === 'unknown' }
}

/** Fields of a model can all become columns of another table: scalars, enums and value objects. */
export function flattenable(context: SchemaContext, name: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(name)) return false
  seen.add(name)
  const model = findModel(context.schema, name)
  if (!model) return false
  return allFields(context.schema, model).every((field) => {
    const type = field.type
    if (type.kind === 'primitive') return type.name !== 'any'
    if (type.kind === 'enum') return true
    if (type.kind === 'model') return flattenable(context, type.name, seen)
    return false
  })
}

/** Whether `from` can lead back to `to` through the fields of the models, which makes embedding endless. */
export function reaches(context: SchemaContext, from: string, to: string, seen: Set<string> = new Set()): boolean {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  const model = findModel(context.schema, from)
  if (!model) return false
  return allFields(context.schema, model).some((field) => {
    const next = modelOf(field.type)
    return next !== null && reaches(context, next, to, seen)
  })
}

/** A field of `child` that points back to `owner`: `order: Order` or `orderId`. */
export function backReference(context: SchemaContext, owner: string, child: string): string | null {
  const model = findModel(context.schema, child)
  if (!model) return null
  const ownerWords = nameWords(owner).join('')
  for (const field of allFields(context.schema, model)) {
    if (field.type.kind === 'model' && field.type.name === owner) return field.name
    const words = nameWords(field.name)
    if (words.length >= 2 && words[words.length - 1] === 'id' && words.slice(0, -1).join('') === ownerWords) return field.name
  }
  return null
}

/** A list of `owner` in `child`: both sides list each other. */
export function listsBack(context: SchemaContext, owner: string, child: string): string | null {
  const model = findModel(context.schema, child)
  if (!model) return null
  const field = allFields(context.schema, model).find((item) => item.type.kind === 'array' && modelOf(item.type) === owner)
  return field?.name ?? null
}

/** Singular name of a list field, for the tables and columns made from it (`tags` → `tag`). */
export function singularField(field: string): string {
  const words = nameWords(field)
  if (words.length === 0) return field
  words[words.length - 1] = singularize(words[words.length - 1])
  return words.join('_')
}
