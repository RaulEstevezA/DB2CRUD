/**
 * Keyboard of a tab list (WAI-ARIA tabs pattern), shared by every row of tabs in the interface.
 */
import type { KeyboardEvent } from 'react'

/**
 * Moves to a tab with the arrow keys, Home and End, and selects it.
 *
 * Only the selected tab is in the Tab order, so the keyboard reaches the content after the list in one step.
 *
 * @param event Key pressed on the element with `role="tablist"`.
 * @param select Selects the tab at an index.
 */
export function onTabListKeyDown(event: KeyboardEvent<HTMLElement>, select: (index: number) => void) {
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
  const current = tabs.indexOf(document.activeElement as HTMLElement)
  if (current < 0) return
  const next =
    event.key === 'ArrowRight'
      ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft'
        ? (current - 1 + tabs.length) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : null
  if (next === null) return
  event.preventDefault()
  select(next)
  tabs[next].focus()
}
