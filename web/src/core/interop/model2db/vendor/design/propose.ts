import { nameWords } from '../model/naming.ts'
import { allFields, type FieldDef, type ModelDef, type ModelSchema } from '../model/schema.ts'
import { analyze, hasKey, isParentOnly, keyable, keyField, shapeOf, type SchemaContext } from './analysis.ts'
import { decision, reason } from './decision.ts'
import { declaresKey, declaresUnique } from './hints.ts'
import type { DesignStrategy } from './strategy.ts'
import { documentStrategy } from './targets/document.ts'
import { keyValueStrategy } from './targets/keyValue.ts'
import { wideColumnStrategy } from './targets/wideColumn.ts'
import { relationalStrategy } from './targets/relational.ts'
import type { Decision, Design, EnumDesign, FieldDesign, KeyChoice, ModelDesign, StorageTarget } from './types.ts'

/** One strategy per kind of database. Adding a kind means adding its strategy here. */
const STRATEGIES: Record<StorageTarget, DesignStrategy> = {
  relational: relationalStrategy,
  document: documentStrategy,
  keyvalue: keyValueStrategy,
  widecolumn: wideColumnStrategy,
}

/** Proposes a persistence design for a model schema. Facts declared in the input (keys, relations,
 * unique columns) are exact; inferences carry the confidence they deserve, and anything that could
 * reasonably go two ways is left pending with a suggestion, never applied (UX_GUIDE.md, ambiguity). */
export function proposeDesign(schema: ModelSchema, target: StorageTarget): Design {
  const strategy = STRATEGIES[target]
  const context = analyze(schema)
  return {
    target,
    models: schema.models.map((model) => proposeModel(context, model, strategy)),
    enums: schema.enums.map((item) => strategy.enum(item.name)).filter((item): item is EnumDesign => item !== null),
  }
}

function proposeModel(context: SchemaContext, model: ModelDef, strategy: DesignStrategy): ModelDesign {
  const fields = allFields(context.schema, model)
  return {
    model: model.name,
    include: !isParentOnly(context, model.name),
    key: proposeKey(model, fields, strategy),
    fields: fields.map((field) => proposeField(context, model, fields, field, strategy)),
  }
}

function proposeKey(model: ModelDef, fields: FieldDef[], strategy: DesignStrategy): Decision<KeyChoice> {
  const declared = fields.filter(declaresKey)
  const options: KeyChoice[] = [
    ...fields
      .filter((field) => keyable(field) || declared.includes(field))
      .map((field): KeyChoice => ({ kind: 'field', field: field.name })),
    ...strategy.surrogateKeys,
  ]
  if (declared.length > 1)
    return decision<KeyChoice>(
      { kind: 'field', field: declared[0].name },
      'conflict',
      [reason('keyCandidates', { fields: declared.map((f) => f.name).join(', ') })],
      options,
    )
  const found = keyField(model, fields)
  if (found)
    return decision<KeyChoice>(
      { kind: 'field', field: found.field.name },
      found.declared ? 'exact' : 'high',
      [reason(found.declared ? 'keyDeclared' : 'keyNamed', { field: found.field.name })],
      options,
    )
  return strategy.keyWithoutField(model, fields, options)
}

function proposeField(context: SchemaContext, model: ModelDef, fields: FieldDef[], field: FieldDef, strategy: DesignStrategy): FieldDesign {
  const design: FieldDesign = { field: field.name, include: true }
  const shape = shapeOf(context, field.type)
  if (shape) {
    design.relation = strategy.relation(context, model, field, shape)
    return design
  }
  const foreignKey = strategy.foreignKeys ? proposeForeignKey(context, model, fields, field) : null
  if (foreignKey) design.foreignKey = foreignKey
  const unique = proposeUnique(model, fields, field)
  if (unique) design.unique = unique
  const wholeNumber = strategy.wholeNumbers && !foreignKey ? proposeWholeNumber(model, fields, field) : null
  if (wholeNumber) design.wholeNumber = wholeNumber
  return design
}

/** Unique columns: declared ones are exact; names that are usually unique are only suggested. */
function proposeUnique(model: ModelDef, fields: FieldDef[], field: FieldDef): Decision<boolean> | null {
  if (field.type.kind !== 'primitive') return null
  const key = keyField(model, fields)
  if (key?.field.name === field.name) return null
  if (declaresUnique(field)) return decision(true, 'exact', [reason('uniqueDeclared')], [true, false])
  const words = nameWords(field.name)
  const last = words[words.length - 1]
  if (['email', 'username', 'slug', 'sku', 'isbn', 'login', 'handle'].includes(last) && words.length <= 2)
    return decision(true, 'review', [reason('uniqueNamed', { field: field.name })], [true, false])
  return null
}

/** Last words of names that count things: a number without a size (TypeScript's `number`) named like
 * this is most likely whole. */
const WHOLE_NUMBER_WORDS = new Set([
  'count',
  'quantity',
  'qty',
  'age',
  'year',
  'position',
  'rank',
  'level',
  'version',
  'attempts',
  'retries',
  'votes',
  'likes',
  'views',
  'stock',
  'page',
  'port',
  'priority',
  'sequence',
  'index',
  'id',
  'number',
  'bytes',
  'step',
  'floor',
  'seats',
  'copies',
])

/** `quantity: number`: stored as a whole number. Keys and foreign keys already take the key's type. */
function proposeWholeNumber(model: ModelDef, fields: FieldDef[], field: FieldDef): Decision<boolean> | null {
  if (field.type.kind !== 'primitive' || field.type.name !== 'float' || field.type.bits !== undefined) return null
  if (keyField(model, fields)?.field.name === field.name) return null
  const words = nameWords(field.name)
  const named = WHOLE_NUMBER_WORDS.has(words[words.length - 1]) || (words.length > 1 && ['num', 'count'].includes(words[0]))
  if (!named) return null
  return decision(true, 'probable', [reason('wholeNumberNamed', { field: field.name })], [true, false])
}

/** `customerId` next to a `Customer` model: the column most likely holds its key. */
function proposeForeignKey(context: SchemaContext, model: ModelDef, fields: FieldDef[], field: FieldDef): Decision<string | null> | null {
  if (!keyable({ ...field, nullable: false })) return null
  const words = nameWords(field.name)
  if (words.length < 2 || words[words.length - 1] !== 'id') return null
  if (keyField(model, fields)?.field.name === field.name) return null
  const stem = words.slice(0, -1).join('')
  const target = context.schema.models.find((item) => nameWords(item.name).join('') === stem)
  if (!target || !hasKey(context, target.name)) return null
  // `customer: Customer` next to it already says it: the reference reuses this column (physical/relational.ts)
  if (fields.some((other) => other.type.kind === 'model' && other.type.name === target.name)) return null
  return decision<string | null>(target.name, 'high', [reason('foreignKeyNamed', { model: target.name })], [target.name, null])
}
