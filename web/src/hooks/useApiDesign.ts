/**
 * The API design the user reviews, with undo and redo. The design is always reconciled with the current
 * models: a change in the input keeps every decision the user made where it still applies.
 */
import { useCallback, useMemo } from 'react'
import type { ApiDesign } from '../core/api/types.ts'
import { reconcile } from '../core/design/propose.ts'
import type { ModelSchema } from '../core/model/schema.ts'
import { useHistory, type History } from './useHistory.ts'

export interface ApiDesignState {
  /** The design of the current models, or null while there are none */
  design: ApiDesign | null
  /** Applies an edit; it can be undone */
  change: (edit: (design: ApiDesign) => ApiDesign) => void
  /** Back to the proposal, keeping nothing the user decided; it can be undone */
  reset: () => void
  /** Starts over from a loaded design (a project file); the history starts again */
  load: (design: ApiDesign | null) => void
  history: Pick<History<unknown>, 'undo' | 'redo' | 'canUndo' | 'canRedo'>
}

/**
 * @param schema The models the design is about, or null while there are none.
 * @param initial A design to start from (the work kept in this browser), reconciled with the models.
 */
export function useApiDesign(schema: ModelSchema | null, initial: ApiDesign | null = null): ApiDesignState {
  const history = useHistory<ApiDesign | null>(initial)
  const { present, push, reset: restart, undo, redo, canUndo, canRedo } = history
  const design = useMemo(() => (schema ? reconcile(present, schema) : null), [schema, present])
  const change = useCallback(
    (edit: (design: ApiDesign) => ApiDesign) => {
      if (!schema || !design) return
      push(reconcile(edit(design), schema))
    },
    [schema, design, push],
  )
  const reset = useCallback(() => {
    if (schema) push(reconcile(null, schema))
  }, [schema, push])
  const historyState = useMemo(() => ({ undo, redo, canUndo, canRedo }), [undo, redo, canUndo, canRedo])
  return { design, change, reset, load: restart, history: historyState }
}
