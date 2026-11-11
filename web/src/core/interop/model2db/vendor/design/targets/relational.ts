import { findModel, type FieldDef, type ModelDef } from '../../model/schema.ts'
import {
  backReference,
  flattenable,
  hasKey,
  keyable,
  listsBack,
  naturalKey,
  otherUsages,
  type SchemaContext,
  type Shape,
} from '../analysis.ts'
import { decision, reason } from '../decision.ts'
import { declaredRelation, declaresEmbeddable } from '../hints.ts'
import type { DesignStrategy } from '../strategy.ts'
import type { Decision, RelationChoice } from '../types.ts'

/** Tables: references become foreign keys, value objects become columns, lists become child or join tables. */
export const relationalStrategy: DesignStrategy = {
  target: 'relational',
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
  wholeNumbers: true,
  enum: (name) => ({ enum: name, storage: decision('check', 'high', [reason('enumCheck')], ['check', 'native', 'lookup', 'text']) }),
}

function relation(context: SchemaContext, model: ModelDef, field: FieldDef, shape: Shape): Decision<RelationChoice> {
  const declared = declaredRelation(field)
  switch (shape.kind) {
    case 'model': {
      const options: RelationChoice[] = ['reference', ...(flattenable(context, shape.target) ? (['flatten'] as const) : []), 'json']
      const targetModel = findModel(context.schema, shape.target)!
      if (declared === 'embedded' || declaresEmbeddable(targetModel))
        return decision<RelationChoice>(options.includes('flatten') ? 'flatten' : 'json', 'exact', [reason('relationDeclared')], options)
      if (declared === 'manyToOne' || declared === 'oneToOne')
        return decision<RelationChoice>('reference', 'exact', [reason('relationDeclared')], options)
      if (shape.target === model.name) return decision<RelationChoice>('reference', 'exact', [reason('selfReference')], options)
      if (hasKey(context, shape.target))
        return decision<RelationChoice>('reference', 'high', [reason('targetHasKey', { model: shape.target })], options)
      if (options.includes('flatten'))
        return decision<RelationChoice>('flatten', 'probable', [reason('valueObject', { model: shape.target })], options)
      return decision<RelationChoice>('reference', 'review', [reason('notFlattenable', { model: shape.target })], options)
    }
    case 'models': {
      const options: RelationChoice[] = ['child', 'join', 'json']
      if (declared === 'oneToMany' || declared === 'elementCollection')
        return decision<RelationChoice>('child', 'exact', [reason('relationDeclared')], options)
      if (declared === 'manyToMany') return decision<RelationChoice>('join', 'exact', [reason('relationDeclared')], options)
      if (shape.target === model.name) return decision<RelationChoice>('child', 'high', [reason('selfReference')], options)
      const back = backReference(context, model.name, shape.target)
      if (back) return decision<RelationChoice>('child', 'high', [reason('backReference', { model: shape.target, field: back })], options)
      const mirror = listsBack(context, model.name, shape.target)
      if (mirror)
        return decision<RelationChoice>('join', 'high', [reason('bothSidesLists', { model: shape.target, field: mirror })], options)
      const others = otherUsages(context, shape.target, model.name, field.name)
      if (others.length > 0 && hasKey(context, shape.target))
        return decision<RelationChoice>(
          'join',
          'review',
          [reason('sharedTarget', { model: shape.target, users: others.map((u) => u.from).join(', ') })],
          options,
        )
      return decision<RelationChoice>(
        'child',
        hasKey(context, shape.target) ? 'probable' : 'high',
        [reason('ownedList', { model: shape.target })],
        options,
      )
    }
    case 'values': {
      const options: RelationChoice[] = ['child', 'array', 'json']
      if (declared === 'elementCollection') return decision<RelationChoice>('child', 'exact', [reason('relationDeclared')], options)
      return decision<RelationChoice>('child', 'probable', [reason('primitiveList')], options)
    }
    case 'map': {
      const options: RelationChoice[] = shape.plain ? ['json', 'child'] : ['json']
      return decision<RelationChoice>('json', 'high', [reason('mapOfValues')], options)
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
