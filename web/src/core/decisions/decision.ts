/**
 * Decisions the tool proposes and the user reviews: the proposed value, how sure the proposal is and why.
 * Review and conflict proposals are never applied on their own; the generated code leaves a `TODO` in
 * their place.
 *
 * Decisions are plain JSON values, so undo and redo only keep previous values and a decision can be saved
 * in a project file as it is.
 */

/** The confidence scale of personal_web_style (patterns/confidence-states.md). Exact, high and probable
 * proposals are applied; review and conflict wait for the user. */
export type Confidence = 'exact' | 'high' | 'probable' | 'review' | 'conflict' | 'none'

export type DecisionStatus = 'active' | 'pending'

/** Why a proposal was made. Codes are translated by the interface (i18n/messages.ts). */
export interface Reason {
  code: ReasonCode
  params?: Record<string, string | number>
}

/** Reason codes grow with the rules that propose decisions. */
export type ReasonCode =
  // Queries and operations
  | 'primaryKey'
  | 'uniqueConstraint'
  | 'indexOnly'
  | 'nestedList'
  | 'foreignKey'
  | 'readOnlyTable'
  // Table roles
  | 'tableWithKey'
  | 'noPrimaryKey'
  | 'joinTable'
  // Deletes
  | 'softDeleteColumn'
  | 'noSoftDeleteColumn'
  // Concurrency
  | 'versionColumn'
  | 'noVersionColumn'
  // Children
  | 'childrenWithoutAction'
  // Hidden columns
  | 'secretNamed'
  | 'noSecrets'
  // Matching application models
  | 'modelName'
  | 'modelNames'
  | 'noModel'
  | 'fieldName'
  | 'fieldWords'
  | 'lookupUnique'
  | 'lookupNotUnique'
  | 'generatedColumn'
  | 'noFieldRequired'
  | 'noField'
  | 'childRows'
  | 'childTables'
  // Mapper projects
  | 'mapperModel'
  | 'mapperField'
  | 'mapperOneWay'
  | 'mapperPending'
  // The user chose it
  | 'manual'

/** One decision. `value` is the proposal while the decision is pending and the choice once it is active;
 * `options` are the values that make sense for this subject. */
export interface Decision<T> {
  value: T
  status: DecisionStatus
  confidence: Confidence
  /** Set when the user made or confirmed the choice. */
  manual?: boolean
  reasons: Reason[]
  options: T[]
}

/** Whether two decision values are the same (they are plain JSON). */
export function sameValue<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A new proposal that keeps the user's earlier choice when it is still one of the options. */
export function keep<T>(previous: Decision<T> | null | undefined, next: Decision<T>): Decision<T> {
  if (!previous?.manual || !next.options.some((option) => sameValue(option, previous.value))) return next
  return { ...next, value: previous.value, status: 'active', manual: true }
}

/** A proposal: review and conflict wait for the user, the others are applied. */
export function decision<T>(value: T, confidence: Confidence, reasons: Reason[], options: T[]): Decision<T> {
  return { value, status: confidence === 'review' || confidence === 'conflict' ? 'pending' : 'active', confidence, reasons, options }
}

export function reason(code: ReasonCode, params?: Record<string, string | number>): Reason {
  return params ? { code, params } : { code }
}
