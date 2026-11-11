/**
 * Undo and redo over immutable values: design edits return new designs, so keeping them is enough.
 */
import { useCallback, useState } from 'react'

// Enough to undo a long review without keeping every change of a big design forever
const LIMIT = 100

export interface History<T> {
  present: T
  /** A user change: it can be undone */
  push: (value: T) => void
  /** A new starting point (new inputs, a loaded project): the history starts over */
  reset: (value: T) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

/** Undo and redo over a value that is replaced, never changed in place. */
export function useHistory<T>(initial: T): History<T> {
  const [state, setState] = useState<{ past: T[]; present: T; future: T[] }>({ past: [], present: initial, future: [] })
  const push = useCallback(
    (value: T) => setState((current) => ({ past: [...current.past, current.present].slice(-LIMIT), present: value, future: [] })),
    [],
  )
  const reset = useCallback((value: T) => setState({ past: [], present: value, future: [] }), [])
  const undo = useCallback(
    () =>
      setState((current) =>
        current.past.length === 0
          ? current
          : {
              past: current.past.slice(0, -1),
              present: current.past[current.past.length - 1],
              future: [current.present, ...current.future],
            },
      ),
    [],
  )
  const redo = useCallback(
    () =>
      setState((current) =>
        current.future.length === 0
          ? current
          : { past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1) },
      ),
    [],
  )
  return { present: state.present, push, reset, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }
}
