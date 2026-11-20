import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MATCHING_CASES, readCase } from '../matching/test/cases.ts'
import {
  accept,
  chooseModel,
  chooseSource,
  decidePolicy,
  findDecision,
  pendingDecisions,
  setOperationInclude,
  setQueryInclude,
} from './edit.ts'
import { SHOP } from './fixtures.ts'
import { proposeCrud } from './propose.ts'
import { findPolicy, findRepository, findService, type CrudDesign } from './types.ts'

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

describe('matching decisions', () => {
  const { database, models } = readCase(join(MATCHING_CASES, 'directions-typescript'))
  const start = proposeCrud(database, null, models)
  const written = (current: CrudDesign) =>
    current.matching!.tables.find((item) => item.table === 'orders')!.models.find((item) => item.direction === 'input')!
  const products = (current: CrudDesign) => current.matching!.tables.find((item) => item.table === 'products')!.models[0]

  it('lists the models and columns waiting for the user with the other decisions', () => {
    const pending = pendingDecisions(start)
    expect(pending).toContainEqual({ kind: 'model', table: 'products', direction: 'input' })
    expect(pending).toContainEqual({ kind: 'source', table: 'orders', direction: 'output', column: 'status' })
  })

  it('keeps a chosen source when the design is proposed again', () => {
    const edited = proposeCrud(database, chooseSource(start, 'orders', 'input', 'status', null), models)
    const status = written(edited).columns.find((item) => item.column === 'status')!
    expect(status.source).toMatchObject({ value: null, status: 'active', manual: true })
  })

  it('matches the columns again with another model, with its conflicts and unused fields', () => {
    expect(products(start).model.value).toBe('ProductInput')
    const edited = proposeCrud(database, chooseModel(start, 'products', 'input', 'ProductCommand'), models)
    const match = products(edited)
    expect(match.model).toMatchObject({ value: 'ProductCommand', manual: true })
    expect(match.columns.find((item) => item.column === 'price')!.source.confidence).toBe('conflict')
    expect(pendingDecisions(edited)).toContainEqual({ kind: 'source', table: 'products', direction: 'input', column: 'price' })
  })

  it('takes the conflicts of the field chosen, and leaves the one given up unused', () => {
    const edited = proposeCrud(database, chooseSource(start, 'customers', 'both', 'full_name', { kind: 'field', field: 'email' }), models)
    const match = edited.matching!.tables.find((item) => item.table === 'customers')!.models[0]
    expect(match.columns.find((item) => item.column === 'full_name')!.conflicts).toEqual([])
    expect(match.unused).toEqual(['fullName'])
  })

  it('confirms a pending model as it is', () => {
    const edited = accept(start, { kind: 'model', table: 'products', direction: 'input' })
    expect(findDecision(edited, { kind: 'model', table: 'products', direction: 'input' })).toMatchObject({ status: 'active', manual: true })
  })
})
