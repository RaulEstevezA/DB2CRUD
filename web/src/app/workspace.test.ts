import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../examples/index.ts'
import { columnCount, inputLanguage, readDatabase, sourceLabel } from './workspace.ts'

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

  it('reads ORM code when the input is not JSON', () => {
    const text =
      'from sqlalchemy import Column, Integer\n\nclass User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n'
    const read = readDatabase({ text })
    expect(read?.ok).toBe(true)
    if (read?.ok) {
      expect(sourceLabel(read.schema)).toBe('SQLAlchemy')
      expect(read.schema.dialect).toBeNull()
    }
    expect(inputLanguage({ text })).toBe('python')
    expect(inputLanguage({ text: EXAMPLES[0].text })).toBe('json')
  })

  it('says why an input cannot be read', () => {
    expect(readDatabase({ text: '{ "a": ' })).toEqual({ ok: false, error: 'notJson' })
    expect(readDatabase({ text: 'export interface User { id: number }' })).toEqual({ ok: false, error: 'unknownInput' })
    expect(readDatabase({ text: 'import sqlalchemy\n' })).toEqual({ ok: false, error: 'noTables' })
  })

  it('names Model2DB projects with their output', () => {
    const read = readDatabase({ text: EXAMPLES[0].text })
    if (read?.ok) expect(sourceLabel(read.schema)).toMatch(/^Model2DB \(/)
  })
})
