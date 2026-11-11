import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../examples/index.ts'
import { columnCount, readDatabase } from './workspace.ts'

describe('readDatabase', () => {
  it('reads nothing while the input is empty', () => {
    expect(readDatabase({ text: '  ' })).toBeNull()
  })

  it('reads every built-in example into a physical schema', () => {
    for (const example of EXAMPLES) {
      const read = readDatabase({ text: example.text })
      expect(read?.ok, example.id).toBe(true)
      if (read?.ok) expect(columnCount(read.schema)).toBeGreaterThan(0)
    }
  })

  it('says why an input cannot be read', () => {
    expect(readDatabase({ text: 'export interface User { id: number }' })).toEqual({ ok: false, error: 'notJson' })
  })
})
