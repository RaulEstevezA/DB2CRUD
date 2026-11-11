/**
 * The CRUD design the user reviews, with undo and redo. The design always follows the current schema: a
 * change in the input proposes it again and keeps every choice the user made where it still applies.
 */
import { useCallback, useMemo } from 'react'
import { proposeCrud } from '../core/crud/propose.ts'
import type { CrudDesign } from '../core/crud/types.ts'
import type { DbSchema } from '../core/schema/types.ts'
import { useHistory, type History } from './useHistory.ts'

export interface CrudDesignState {
  /** The design of the current schema, or null while there is none */
  design: CrudDesign | null
  /** Applies an edit; it can be undone */
  change: (edit: (design: CrudDesign) => CrudDesign) => void
  /** Back to the proposal, keeping nothing the user decided; it can be undone */
  reset: () => void
  /** A new starting point (another input): the history starts over */
  load: (design: CrudDesign | null) => void
  history: History<CrudDesign | null>
}

export function useCrudDesign(schema: DbSchema | null): CrudDesignState {
  const history = useHistory<CrudDesign | null>(null)
  const { present, push, reset: restart } = history
  const design = useMemo(() => (schema ? proposeCrud(schema, present) : null), [schema, present])
  const change = useCallback(
    (edit: (current: CrudDesign) => CrudDesign) => {
      if (schema && design) push(proposeCrud(schema, edit(design)))
    },
    [schema, design, push],
  )
  const reset = useCallback(() => {
    if (schema) push(proposeCrud(schema))
  }, [schema, push])
  return { design, change, reset, load: restart, history }
}
