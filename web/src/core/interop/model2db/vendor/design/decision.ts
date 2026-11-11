import type { Confidence, Decision, Reason, ReasonCode } from './types.ts'

/** A proposal: review and conflict wait for the user, the others are applied. */
export function decision<T>(value: T, confidence: Confidence, reasons: Reason[], options: T[]): Decision<T> {
  return { value, status: confidence === 'review' || confidence === 'conflict' ? 'pending' : 'active', confidence, reasons, options }
}

export function reason(code: ReasonCode, params?: Record<string, string | number>): Reason {
  return params ? { code, params } : { code }
}
