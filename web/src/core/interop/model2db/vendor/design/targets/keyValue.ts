import { findModel, type FieldDef, type ModelDef } from '../../model/schema.ts'
import { flattenable, hasKey, keyable, naturalKey, type SchemaContext, type Shape } from '../analysis.ts'
import { decision, reason } from '../decision.ts'
import { declaredRelation, declaresEmbeddable } from '../hints.ts'
import type { DesignStrategy } from '../strategy.ts'
import type { Decision, RelationChoice } from '../types.ts'

/** Keys and values (Redis): each stored model is a hash under its own key (`order:42`); a list or a map
 * of it is a list, set or hash under the owner's key (`order:42:tags`). How the data is read decides most
 * of it, and the model does not say, so lists of other models wait for the user. */
export const keyValueStrategy: DesignStrategy = {
  target: 'keyvalue',
  surrogateKeys: [
    { kind: 'surrogate', type: 'integer' },
    { kind: 'surrogate', type: 'uuid' },
  ],
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
  foreignKeys: true,
  wholeNumbers: false,
  enum: () => null,
}

function relation(context: SchemaContext, model: ModelDef, field: FieldDef, shape: Shape): Decision<RelationChoice> {
  const declared = declaredRelation(field)
  switch (shape.kind) {
    case 'model': {
      const options: RelationChoice[] = ['reference', ...(flattenable(context, shape.target) ? (['flatten'] as const) : []), 'json']
      if (declared === 'embedded' || declaresEmbeddable(findModel(context.schema, shape.target)!))
        return decision<RelationChoice>(options.includes('flatten') ? 'flatten' : 'json', 'exact', [reason('relationDeclared')], options)
      if (shape.target === model.name) return decision<RelationChoice>('reference', 'exact', [reason('selfReference')], options)
      if (hasKey(context, shape.target))
        return decision<RelationChoice>('reference', 'high', [reason('targetHasKey', { model: shape.target })], options)
      if (options.includes('flatten'))
        return decision<RelationChoice>('flatten', 'probable', [reason('valueObject', { model: shape.target })], options)
      return decision<RelationChoice>('json', 'probable', [reason('valueAsJson', { model: shape.target })], options)
    }
    case 'models': {
      const options: RelationChoice[] = ['child', 'json']
      // A set of the other models' keys, or the whole list as JSON: it depends on how the list is read
      if (hasKey(context, shape.target))
        return decision<RelationChoice>('child', 'review', [reason('keySet', { model: shape.target })], options)
      return decision<RelationChoice>('json', 'review', [reason('listAsJson', { model: shape.target })], options)
    }
    case 'values':
      return decision<RelationChoice>('child', 'probable', [reason('valueList')], ['child', 'json'])
    case 'map': {
      const options: RelationChoice[] = shape.plain ? ['child', 'json'] : ['json']
      return decision<RelationChoice>(options[0], 'probable', [reason(shape.plain ? 'valueHash' : 'mapOfValues')], options)
    }
    case 'free':
      return decision<RelationChoice>(
        'json',
        shape.unknown ? 'review' : 'probable',
        [reason('freeShape', { type: field.originalType ?? '' })],
        ['json'],
      )
  }
}
