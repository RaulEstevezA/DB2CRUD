/**
 * Keyboard shortcuts for undo and redo on the whole page, except inside fields, which have their own.
 */
import { useEffect } from 'react'
import type { History } from './useHistory.ts'

/** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y), except while typing in a field: it has its own undo. */
export function useUndoShortcuts(history: Pick<History<unknown>, 'canUndo' | 'canRedo' | 'undo' | 'redo'>) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const element = event.target as HTMLElement | null
      if (element && element.closest('input, textarea, select, [contenteditable="true"], .cm-editor') !== null) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey && history.canUndo) {
        event.preventDefault()
        history.undo()
      } else if (((key === 'z' && event.shiftKey) || key === 'y') && history.canRedo) {
        event.preventDefault()
        history.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history])
}
