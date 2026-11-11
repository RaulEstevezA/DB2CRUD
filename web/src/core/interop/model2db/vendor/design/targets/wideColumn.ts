import { findModel, type FieldDef, type ModelDef } from '../../model/schema.ts'
import { flattenable, hasKey, keyable, naturalKey, reaches, type SchemaContext, type Shape } from '../analysis.ts'
import { decision, reason } from '../decision.ts'
import { declaredRelation, declaresEmbeddable } from '../hints.ts'
import type { DesignStrategy } from '../strategy.ts'
import type { Decision, RelationChoice } from '../types.ts'

/** Wide columns (Cassandra, ScyllaDB): a table per stored model, partitioned by its key. There are no joins:
 * values live inside the row (user-defined types, collections) and a list of other models is a table of its
 * own, partitioned by the owner's key, so it is read with one query. Which tables to keep depends on the
 * queries, which the model does not say: lists of other models wait for the user. */
export const wideColumnStrategy: DesignStrategy = {
  target: 'widecolumn',
  // No auto-increment: a new key is a UUID
  surrogateKeys: [{ kind: 'surrogate', type: 'uuid' }],
  keyWithoutField(model, fields, options) {
    const suggestion = this.surrogateKeys[0]
    const candidates = fields.filter((field) => keyable(field) && naturalKey(model, field))
    if (candidates.length > 0)
      return decision(
        suggestion,
        'review',
        [reason('keyCandidates', { fields: candidates.map((field) => field.name).join(', ') })],
        options,
      )
    return decision(suggestion, 'probable', [reason('keyMissing')], options)
  },
  relation,
  // No foreign keys: a column holding another model's key is a plain column
  foreignKeys: false,
  wholeNumbers: false,
  enum: () => null,
}

function relation(context: SchemaContext, model: ModelDef, field: FieldDef, shape: Shape): Decision<RelationChoice> {
  const declared = declaredRelation(field)
  switch (shape.kind) {
    case 'model': {
      const recursive = reaches(context, shape.target, model.name)
      const options: RelationChoice[] = [
        'reference',
        ...(recursive ? [] : (['embed'] as const)),
        ...(flattenable(context, shape.target) ? (['flatten'] as const) : []),
        'json',
      ]
      if (shape.target === model.name) return decision<RelationChoice>('reference', 'exact', [reason('selfReference')], options)
      if (declared === 'embedded' || declaresEmbeddable(findModel(context.schema, shape.target)!))
        return decision<RelationChoice>(recursive ? 'json' : 'embed', 'exact', [reason('relationDeclared')], options)
      if (hasKey(context, shape.target))
        return decision<RelationChoice>('reference', 'high', [reason('targetHasKey', { model: shape.target })], options)
      if (recursive) return decision<RelationChoice>('json', 'probable', [reason('recursiveEmbed', { model: shape.target })], options)
      return decision<RelationChoice>('embed', 'probable', [reason('valueType', { model: shape.target })], options)
    }
    case 'models': {
      const recursive = reaches(context, shape.target, model.name)
      const options: RelationChoice[] = ['child', ...(recursive ? [] : (['embed'] as const)), 'json']
      if (hasKey(context, shape.target))
        return decision<RelationChoice>('child', 'review', [reason('partitionTable', { model: shape.target })], options)
      if (recursive) return decision<RelationChoice>('json', 'review', [reason('recursiveEmbed', { model: shape.target })], options)
      return decision<RelationChoice>('embed', 'review', [reason('embeddedList', { model: shape.target })], options)
    }
    case 'values':
      return decision<RelationChoice>('array', 'high', [reason('nativeCollection')], ['array', 'json'])
    case 'map':
      return shape.plain
        ? decision<RelationChoice>('array', 'high', [reason('nativeCollection')], ['array', 'json'])
        : decision<RelationChoice>('json', 'probable', [reason('mapOfValues')], ['json'])
    case 'free':
      return decision<RelationChoice>(
        'json',
        shape.unknown ? 'review' : 'probable',
        [reason('freeShape', { type: field.originalType ?? '' })],
        ['json'],
      )
  }
}
