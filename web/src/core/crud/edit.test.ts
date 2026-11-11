import { describe, expect, it } from 'vitest'
import { accept, decidePolicy, findDecision, pendingDecisions, setOperationInclude, setQueryInclude } from './edit.ts'
import { SHOP } from './fixtures.ts'
import { proposeCrud } from './propose.ts'
import { findPolicy, findRepository, findService } from './types.ts'

const design = proposeCrud(SHOP)

describe('pendingDecisions', () => {
  it('lists every proposal waiting for the user, table by table', () => {
    expect(pendingDecisions(design)).toEqual([
      { kind: 'policy', table: 'customers', decision: 'children' },
      { kind: 'policy', table: 'customers', decision: 'hidden' },
      { kind: 'policy', table: 'categories', decision: 'children' },
      { kind: 'policy', table: 'products', decision: 'delete' },
      { kind: 'policy', table: 'products', decision: 'children' },
      { kind: 'query', table: 'products', id: 'findAllBy:status' },
      { kind: 'policy', table: 'audit_log', decision: 'role' },
    ])
  })
})

describe('edits', () => {
  it('chooses a table decision and leaves the previous design untouched', () => {
    const edited = decidePolicy(design, 'products', 'delete', { mode: 'hard' })
    expect(findPolicy(edited, 'products')!.delete).toMatchObject({ value: { mode: 'hard' }, status: 'active', manual: true })
    expect(findPolicy(design, 'products')!.delete.value).toEqual({ mode: 'soft', column: 'deleted_at' })
  })

  it('ignores values that are not options, and decisions the table does not have', () => {
    expect(decidePolicy(design, 'orders', 'delete', { mode: 'soft', column: 'x' })).toEqual(design)
    expect(decidePolicy(design, 'orders', 'children', 'block')).toEqual(design)
  })

  it('turns queries and operations on and off', () => {
    const edited = setOperationInclude(setQueryInclude(design, 'products', 'findAllBy:status', false), 'customers', 'delete', false)
    expect(findRepository(edited, 'products')!.queries.find((query) => query.id === 'findAllBy:status')!.include).toMatchObject({
      value: false,
      manual: true,
    })
    expect(findService(edited, 'customers')!.operations.find((operation) => operation.id === 'delete')!.include.value).toBe(false)
  })

  it('confirms a proposal as it is, which removes it from the pending list', () => {
    const ref = { kind: 'policy', table: 'customers', decision: 'hidden' } as const
    const edited = accept(design, ref)
    expect(findDecision(edited, ref)).toMatchObject({ value: ['password_hash'], status: 'active', manual: true })
    expect(pendingDecisions(edited)).not.toContainEqual(ref)
  })

  it('keeps the edits when the design is proposed again', () => {
    const edited = proposeCrud(SHOP, decidePolicy(design, 'categories', 'children', 'deleteFirst'))
    expect(findPolicy(edited, 'categories')!.children!.value).toBe('deleteFirst')
  })
})
