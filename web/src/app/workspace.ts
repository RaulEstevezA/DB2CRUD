/**
 * Workspace logic the interface uses, kept out of the components so it can be tested: reading the database
 * input and counting what was read.
 */
import { readModel2DBProject, type Model2DBReadResult } from '../core/interop/model2db/read.ts'
import type { DbSchema } from '../core/schema/types.ts'

export interface InputState {
  text: string
  /** File name it was opened from */
  fileName?: string
}

export const EMPTY_INPUT: InputState = { text: '' }

/** The physical schema of the input, or why it cannot be read; null while the input is empty. */
export function readDatabase(input: InputState): Model2DBReadResult | null {
  return input.text.trim() === '' ? null : readModel2DBProject(input.text)
}

/** Count of columns in every table. */
export function columnCount(schema: DbSchema): number {
  return schema.tables.reduce((total, table) => total + table.columns.length, 0)
}
