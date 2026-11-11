import { findModel, type FieldDef, type ModelDef } from '../../model/schema.ts'
import { backReference, hasKey, isTopLevel, otherUsages, reaches, type SchemaContext, type Shape } from '../analysis.ts'
import { decision, reason } from '../decision.ts'
import { declaredRelation, declaresEmbeddable } from '../hints.ts'
import type { DesignStrategy } from '../strategy.ts'
import type { Decision, RelationChoice } from '../types.ts'

/** Documents (MongoDB): values live inside their document; shared or recursive models are referred to. */
export const documentStrategy: DesignStrategy = {
  target: 'document',
  surrogateKeys: [{ kind: 'surrogate', type: 'objectId' }],
  keyWithoutField(_model, _fields, options) {
    return decision(this.surrogateKeys[0], 'exact', [reason('keyMongo')], options)
  },
  relation,
  foreignKeys: false,
  wholeNumbers: false,
  enum: () => null,
}

function relation(context: SchemaContext, model: ModelDef, field: FieldDef, shape: Shape): Decision<RelationChoice> {
  if (shape.kind !== 'model' && shape.kind !== 'models') {
    const reasons =
      shape.kind === 'values'
        ? [reason('valueArray')]
        : shape.kind === 'map'
          ? [reason('mapOfValues')]
          : [reason('freeShape', { type: field.originalType ?? '' })]
    return decision<RelationChoice>('embed', shape.kind === 'free' && shape.unknown ? 'review' : 'exact', reasons, ['embed'])
  }
  const options: RelationChoice[] = ['embed', 'reference']
  const declared = declaredRelation(field)
  // `User.posts` next to `Post.author`: each post already says its user, so the list is read from there
  const back =
    shape.kind === 'models' && shape.target !== model.name && hasKey(context, shape.target) && declared !== 'embedded'
      ? backReference(context, model.name, shape.target)
      : null
  if (back)
    return decision<RelationChoice>('child', 'high', [reason('backReference', { model: shape.target, field: back })], [...options, 'child'])
  if (reaches(context, shape.target, model.name))
    return decision<RelationChoice>(
      'reference',
      shape.target === model.name ? 'exact' : 'high',
      [reason('recursiveEmbed', { model: shape.target })],
      options,
    )
  if (declared === 'embedded' || declared === 'elementCollection' || declaresEmbeddable(findModel(context.schema, shape.target)!))
    return decision<RelationChoice>('embed', 'exact', [reason('relationDeclared')], options)
  if (!hasKey(context, shape.target))
    return decision<RelationChoice>('embed', 'high', [reason('valueObject', { model: shape.target })], options)
  const others = otherUsages(context, shape.target, model.name, field.name)
  if (others.length > 0 || isTopLevel(context, shape.target))
    return decision<RelationChoice>(
      'reference',
      'review',
      [reason('sharedTarget', { model: shape.target, users: others.map((u) => u.from).join(', ') })],
      options,
    )
  return decision<RelationChoice>(
    'embed',
    'probable',
    [reason(shape.kind === 'models' ? 'unboundedList' : 'ownedList', { model: shape.target })],
    options,
  )
}
