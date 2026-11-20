/**
 * The CRUD design the user reviews, with undo and redo. The design always follows the current schema: a
 * change in the input proposes it again and keeps every choice the user made where it still applies. With application
 * models, the design also says how they match the tables, and those choices are kept and undone the same way.
 */
import { useCallback, useMemo } from 'react'
import { proposeCrud } from '../core/crud/propose.ts'
import type { CrudDesign } from '../core/crud/types.ts'
import type { MapperProject } from '../core/interop/mapper/read.ts'
import type { ModelSchema } from '../core/model/schema.ts'
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

export function useCrudDesign(
  schema: DbSchema | null,
  models: ModelSchema | null = null,
  project: MapperProject | null = null,
): CrudDesignState {
  const history = useHistory<CrudDesign | null>(null)
  const { present, push, reset: restart } = history
  const design = useMemo(() => (schema ? proposeCrud(schema, present, models, project) : null), [schema, present, models, project])
  const change = useCallback(
    (edit: (current: CrudDesign) => CrudDesign) => {
      if (schema && design) push(proposeCrud(schema, edit(design), models, project))
    },
    [schema, design, models, project, push],
  )
  const reset = useCallback(() => {
    if (schema) push(proposeCrud(schema, null, models, project))
  }, [schema, models, project, push])
  return { design, change, reset, load: restart, history }
}
