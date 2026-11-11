/**
 * Workspace logic the interface uses, kept out of the components so it can be tested: reading the input
 * with its chosen or detected format, and counting what was read.
 */
import { allFields, type ModelSchema } from '../core/model/schema.ts'
import { detectFormat, parseInput } from '../core/importers/registry.ts'
import type { InputFormatId, ParseOutcome } from '../core/importers/types.ts'

export interface InputState {
  text: string
  /** null: detected from the text */
  format: InputFormatId | null
  /** File name it was opened from, for detection */
  fileName?: string
  /** Where it came from when another tool sent it */
  receivedFrom?: string
}

export const EMPTY_INPUT: InputState = { text: '', format: null }

export interface ReadInput {
  format: InputFormatId | null
  outcome: ParseOutcome | null
}

/**
 * Reads the input with its chosen or detected format.
 *
 * @returns The format used and the outcome; no outcome while the input is empty or its format unknown.
 *   A schema without models is reported as `noModels`: there is nothing to make an API of.
 */
export function readInput(input: InputState): ReadInput {
  if (input.text.trim() === '') return { format: input.format, outcome: null }
  const format = input.format ?? detectFormat(input.text, input.fileName)
  if (!format) return { format: null, outcome: null }
  const outcome = parseInput(input.text, format, { rootName: 'Root' })
  if (outcome.ok && outcome.schema.models.length === 0) return { format, outcome: { ok: false, error: { code: 'noModels' } } }
  return { format, outcome }
}

/** Count of fields in every model, inherited ones included. */
export function fieldCount(schema: ModelSchema): number {
  return schema.models.reduce((total, model) => total + allFields(schema, model).length, 0)
}
