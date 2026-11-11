import type { ModelSchema } from '../model/schema.ts'
import { proposeDesign } from './propose.ts'
import {
  FIELD_DECISIONS,
  sameValue,
  type Decision,
  type Design,
  type FieldDecisionKind,
  type FieldDesign,
  type ModelDesign,
  type StorageTarget,
} from './types.ts'

/** Edits of a design. Each returns a new design and leaves the previous one untouched, so the history
 * can keep it for undo. */

/** Which decision an edit is about. */
export type DecisionRef =
  { kind: 'key'; model: string } | { kind: FieldDecisionKind; model: string; field: string } | { kind: 'enum'; enum: string }

function mapModel(design: Design, model: string, change: (item: ModelDesign) => ModelDesign): Design {
  return { ...design, models: design.models.map((item) => (item.model === model ? change(item) : item)) }
}

function mapField(design: Design, model: string, field: string, change: (item: FieldDesign) => FieldDesign): Design {
  return mapModel(design, model, (item) => ({ ...item, fields: item.fields.map((f) => (f.field === field ? change(f) : f)) }))
}

/** The user chooses a value (or confirms the suggestion): the decision becomes active and manual. */
function choose<T>(decision: Decision<T>, value: T): Decision<T> {
  return { ...decision, value, status: 'active', manual: true }
}

export function getDecision(design: Design, ref: DecisionRef): Decision<unknown> | undefined {
  if (ref.kind === 'enum') return design.enums.find((item) => item.enum === ref.enum)?.storage
  const model = design.models.find((item) => item.model === ref.model)
  if (ref.kind === 'key') return model?.key
  return model?.fields.find((item) => item.field === ref.field)?.[ref.kind]
}

/** Chooses a value for a decision; without a value, confirms the suggestion as it is. */
export function decide(design: Design, ref: DecisionRef, value?: unknown): Design {
  const current = getDecision(design, ref)
  if (!current) return design
  const next = value === undefined ? current.value : value
  if (!current.options.some((option) => sameValue(option, next))) return design
  if (ref.kind === 'enum')
    return {
      ...design,
      enums: design.enums.map((item) =>
        item.enum === ref.enum ? { ...item, storage: choose(item.storage, next as typeof item.storage.value) } : item,
      ),
    }
  if (ref.kind === 'key')
    return mapModel(design, ref.model, (item) => (item.key ? { ...item, key: choose(item.key, next as typeof item.key.value) } : item))
  return mapField(design, ref.model, ref.field, (item) => {
    const decision = item[ref.kind] as Decision<unknown> | undefined
    return decision ? { ...item, [ref.kind]: choose(decision, next) } : item
  })
}

export function setModelInclude(design: Design, model: string, include: boolean): Design {
  return mapModel(design, model, (item) => ({ ...item, include }))
}

export function setTableName(design: Design, model: string, table: string): Design {
  const name = table.trim()
  return mapModel(design, model, (item) => {
    const { table: _old, ...rest } = item
    return name ? { ...rest, table: name } : rest
  })
}

export function setFieldInclude(design: Design, model: string, field: string, include: boolean): Design {
  return mapField(design, model, field, (item) => ({ ...item, include }))
}

export function setFieldIndex(design: Design, model: string, field: string, index: boolean): Design {
  return mapField(design, model, field, (item) => {
    const { index: _old, ...rest } = item
    return index ? { ...rest, index } : rest
  })
}

/** A column name or type written by the user; an empty text goes back to the derived one. */
export function setFieldOverride(design: Design, model: string, field: string, key: 'column' | 'type', value: string): Design {
  const text = value.trim()
  return mapField(design, model, field, (item) => {
    const next = { ...item }
    if (text) next[key] = text
    else delete next[key]
    return next
  })
}

/** Keeps a decision the user made if the fresh proposal still offers that value. */
function keep<T>(fresh: Decision<T> | undefined, old: Decision<T> | undefined): Decision<T> | undefined {
  if (!fresh || !old?.manual) return fresh
  return fresh.options.some((option) => sameValue(option, old.value))
    ? { ...fresh, value: old.value, status: 'active', manual: true }
    : fresh
}

/** A fresh proposal for the schema that keeps everything the user decided on the previous design wherever
 * it still applies, so editing the input never throws the user's review away. */
export function reconcile(previous: Design | null, schema: ModelSchema, target: StorageTarget): Design {
  const fresh = proposeDesign(schema, target)
  if (!previous || previous.target !== target) return fresh
  return {
    ...fresh,
    models: fresh.models.map((model) => {
      const old = previous.models.find((item) => item.model === model.model)
      if (!old) return model
      return {
        ...model,
        include: old.include,
        ...(old.table ? { table: old.table } : {}),
        key: keep(model.key, old.key),
        fields: model.fields.map((field) => {
          const was = old.fields.find((item) => item.field === field.field)
          if (!was) return field
          const next: FieldDesign = { ...field, include: was.include }
          for (const kind of FIELD_DECISIONS) {
            const kept = keep(field[kind] as Decision<unknown> | undefined, was[kind] as Decision<unknown> | undefined)
            if (kept) (next as unknown as Record<string, unknown>)[kind] = kept
          }
          if (was.index) next.index = true
          if (was.column) next.column = was.column
          if (was.type) next.type = was.type
          return next
        }),
      }
    }),
    enums: fresh.enums.map((item) => {
      const old = previous.enums.find((other) => other.enum === item.enum)
      return { ...item, storage: keep(item.storage, old?.storage) ?? item.storage }
    }),
  }
}
