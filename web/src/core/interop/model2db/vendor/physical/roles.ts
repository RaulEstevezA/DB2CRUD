import { allFields, findModel, modelOf, type ModelSchema } from '../model/schema.ts'
import { analyze, isParentOnly, isTopLevel, reaches } from '../design/analysis.ts'
import { findModelDesign, type Design, type RelationChoice } from '../design/types.ts'

/** What happens to each model once the decisions are applied:
 * - `stored`: it has its own table or collection
 * - `embedded`: it only lives inside others (flattened columns, JSON, embedded documents)
 * - `parent`: a base class whose fields go into its children
 * - `excluded`: left out by the user
 * - `pending`: it depends on a decision that is still to be made
 * - `unused`: nothing stored refers to it */
export type ModelRole = 'stored' | 'embedded' | 'parent' | 'excluded' | 'pending' | 'unused'

// Relations that need the other model to have its own table or collection
const NEEDS_STORAGE: readonly RelationChoice[] = ['reference', 'child', 'join']

export function modelRoles(schema: ModelSchema, design: Design): Map<string, ModelRole> {
  const context = analyze(schema)
  const roles = new Map<string, ModelRole>()
  const queue: string[] = []
  for (const model of schema.models) {
    if (!isTopLevel(context, model.name)) continue
    if (findModelDesign(design, model.name)?.include === false)
      roles.set(model.name, isParentOnly(context, model.name) ? 'parent' : 'excluded')
    else {
      roles.set(model.name, 'stored')
      queue.push(model.name)
    }
  }
  // Walks from what is stored: each relation decides what the model it leads to becomes. Inside flattened
  // columns or JSON everything is part of the value; an embedded document can still refer to others.
  const embedded = new Set<string>()
  const pending = new Set<string>()
  // Embedded documents and user-defined types can still refer to other models; flattened columns and JSON cannot
  const nested = design.target === 'document' || design.target === 'widecolumn'
  const visit = (name: string, inside: boolean) => {
    const model = findModel(schema, name)
    const item = findModelDesign(design, name)
    if (!model || !item) return
    for (const field of allFields(schema, model)) {
      const decided = item.fields.find((other) => other.field === field.name)
      const target = modelOf(field.type)
      if (!decided?.include || !decided.relation || !target || target === name) continue
      if (decided.relation.status === 'pending') {
        pending.add(target)
        continue
      }
      const storesTarget = NEEDS_STORAGE.includes(decided.relation.value) && (nested || !inside)
      if (storesTarget) {
        if (roles.get(target) !== 'stored') {
          roles.set(target, 'stored')
          queue.push(target)
        }
      } else if (!embedded.has(target)) {
        embedded.add(target)
        visit(target, !nested)
      }
    }
  }
  while (queue.length > 0) visit(queue.shift()!, false)
  // Models that only refer to each other (`Author.books` and `Book.author`) are never reached from a model
  // nobody uses: a relation between them that needs storage stores its target, and the walk goes on
  for (let changed = true; changed;) {
    changed = false
    for (const model of schema.models) {
      if (roles.has(model.name) || embedded.has(model.name)) continue
      const item = findModelDesign(design, model.name)
      for (const field of allFields(schema, model)) {
        const decided = item?.fields.find((other) => other.field === field.name)
        const target = modelOf(field.type)
        const relation = decided?.relation
        if (!decided?.include || !relation || relation.status !== 'active' || !target || roles.has(target)) continue
        if (!NEEDS_STORAGE.includes(relation.value) || !reaches(context, target, model.name)) continue
        roles.set(target, 'stored')
        queue.push(target)
        changed = true
      }
      while (queue.length > 0) visit(queue.shift()!, false)
    }
  }
  for (const model of schema.models) {
    if (roles.has(model.name)) continue
    if (embedded.has(model.name)) roles.set(model.name, 'embedded')
    else if (pending.has(model.name)) roles.set(model.name, 'pending')
    else roles.set(model.name, 'unused')
  }
  return roles
}
