/**
 * What the endpoints pane needs to point at a decision or an endpoint: stable element ids, so the review
 * list and the list of problems can move the focus to them.
 */
import type { DecisionRef } from '../core/design/edit.ts'

/** Id of the element of a decision in the endpoints pane. */
export function decisionElementId(ref: DecisionRef): string {
  const raw = ref.kind === 'expose' || ref.kind === 'key' ? `${ref.kind}-${ref.model}` : `${ref.kind}-${ref.model}-${ref.field}`
  return `decision-${raw.replace(/[^\w-]/g, '_')}`
}

/** Id of the element of an endpoint in the endpoints pane. */
export function endpointElementId(id: string): string {
  return `endpoint-${id.replace(/[^\w-]/g, '_')}`
}

/** Moves the focus to an element of the pane and scrolls to it. */
export function focusElement(id: string) {
  const element = document.getElementById(id)
  if (!element) return
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.focus({ preventScroll: true })
}
