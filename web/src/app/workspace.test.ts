/**
 * Tests of the workspace logic of the interface.
 */
import { describe, expect, it } from 'vitest'
import { fieldCount, readInput } from './workspace.ts'

describe('readInput', () => {
  it('detects the format when none is chosen', () => {
    const read = readInput({ text: 'export interface User { id: number; name: string }', format: null })
    expect(read.format).toBe('typescript')
    expect(read.outcome?.ok && fieldCount(read.outcome.schema)).toBe(2)
  })

  it('uses the chosen format and reports where an error is', () => {
    const read = readInput({ text: '{"id": 1,}', format: 'json' })
    expect(read.outcome).toMatchObject({ ok: false, error: { code: 'syntax', line: 1 } })
  })

  it('reports an input without models', () => {
    expect(readInput({ text: '[]', format: 'json' }).outcome).toMatchObject({ ok: false, error: { code: 'noModels' } })
  })

  it('reads nothing while the input is empty', () => {
    expect(readInput({ text: '  ', format: null })).toEqual({ format: null, outcome: null })
  })
})
