/**
 * The reader of Mapper projects, on the projects of shared/test-cases/matching/mapper-*.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { invertible, isMapperProject, mapperModels, readMapperProject } from '../read.ts'

const WRITE = readFileSync(resolve(process.cwd(), '../shared/test-cases/matching/mapper-write/models.mapper.json'), 'utf8')
const edited = (change: (value: Record<string, unknown>) => void) => {
  const value = JSON.parse(WRITE) as Record<string, unknown>
  change(value)
  return JSON.stringify(value)
}

describe('readMapperProject', () => {
  it('reads both sides and the mappings', () => {
    expect(isMapperProject(WRITE)).toBe(true)
    const read = readMapperProject(WRITE)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.project.source.model).toBe('CustomerForm')
    expect(read.project.target.model).toBe('Customer')
    expect(read.project.mappings[0].fields.map((field) => field.transform.kind)).toContain('concat')
    expect(read.project.mappings[0].ignoredSources).toEqual(['legacyCode'])
    expect(mapperModels(read.project).models.map((model) => model.name)).toEqual(['CustomerForm', 'Customer'])
  })

  it('rejects other files, newer versions and damaged projects with the path of the problem', () => {
    expect(readMapperProject('not json')).toEqual({ ok: false, error: 'notJson' })
    expect(readMapperProject('{"format":"model-schema","version":1}')).toEqual({ ok: false, error: 'notProject' })
    expect(readMapperProject(edited((value) => (value.version = 2)))).toEqual({ ok: false, error: 'newerVersion' })
    expect(readMapperProject(edited((value) => ((value.mapping as { root: string }).root = 'Other->Customer')))).toEqual({
      ok: false,
      error: 'invalid',
      path: '$.mapping.root',
    })
    expect(readMapperProject(edited((value) => delete (value.target as Record<string, unknown>).model))).toEqual({
      ok: false,
      error: 'invalid',
      path: '$.target',
    })
  })

  it('knows which transformations can be undone without loss', () => {
    expect(invertible({ kind: 'direct' })).toBe(true)
    expect(invertible({ kind: 'epoch', unit: 'seconds' })).toBe(true)
    expect(invertible({ kind: 'arithmetic', operator: '*', operand: 100 })).toBe(true)
    expect(invertible({ kind: 'arithmetic', operator: '*', operand: 0 })).toBe(false)
    expect(
      invertible({
        kind: 'enum',
        pairs: [
          { from: 'A', to: 'a' },
          { from: 'B', to: 'b' },
        ],
      }),
    ).toBe(true)
    expect(
      invertible({
        kind: 'enum',
        pairs: [
          { from: 'A', to: 'a' },
          { from: 'B', to: 'a' },
        ],
      }),
    ).toBe(false)
    expect(invertible({ kind: 'enum', pairs: [{ from: 'A', to: 'a' }], fallback: 'a' })).toBe(false)
    expect(invertible({ kind: 'concat', separator: ' ' })).toBe(false)
    expect(invertible({ kind: 'expression', expression: 'a + b' })).toBe(false)
  })
})
