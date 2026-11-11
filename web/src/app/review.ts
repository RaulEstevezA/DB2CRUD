/**
 * What the design pane needs to point at a decision: stable element ids, so the review list can move the
 * focus to them.
 */
import type { CrudDecisionRef } from '../core/crud/edit.ts'

/** Element id of a decision in the design pane. */
export function decisionId(ref: CrudDecisionRef): string {
  const subject = ref.kind === 'policy' ? ref.decision : ref.id
  return `decision-${ref.kind}-${ref.table}-${subject}`.replace(/[^A-Za-z0-9_-]/g, '-')
}
