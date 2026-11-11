/**
 * Tests of the sample bodies the generated tests send.
 */
import { describe, expect, it } from 'vitest'
import { example } from '../../test/fixtures.ts'
import { creationOrder, sampleBody, sampleFromPattern, updatableField } from './samples.ts'

describe('sampleFromPattern', () => {
  it('builds strings that simple patterns accept', () => {
    for (const pattern of ['^[0-9]{13}$', '^[A-Z]{3}$', '^[a-z ]+$', '^\\d{5}(-\\d{4})?$', '^(?:EUR|USD)$', '^[a-z0-9-]{3,}$', 'abc']) {
      const value = sampleFromPattern(pattern)
      expect(value, pattern).not.toBeNull()
      expect(new RegExp(pattern).test(value!), `${pattern} → ${value}`).toBe(true)
    }
  })

  it('gives up on patterns it cannot satisfy', () => {
    expect(sampleFromPattern('^(?!admin).+$')).toBeNull()
    expect(sampleFromPattern('^[^a-z]+$')).toBeNull()
    expect(sampleFromPattern('^(a)\\1$')).toBeNull()
  })
})

describe('sampleBody', () => {
  it('builds a body that respects the declared validations', () => {
    const { spec } = example('library')
    const book = spec.resources.find((resource) => resource.name === 'Book')!
    const { sample, problem } = sampleBody(spec, book, 0)
    expect(problem).toBeNull()
    expect(sample.body).toEqual({
      title: 'title 1',
      isbn: '0000000000000',
      authorId: null,
      genre: 'novel',
      pages: 1,
      published: '2024-01-15',
      available: true,
    })
    expect(sample.references).toEqual([{ path: ['authorId'], resource: 'Author' }])
    expect(sampleBody(spec, book, 1).sample.body).toMatchObject({ title: 'title 2', genre: 'essay', pages: 2, available: false })
  })

  it('leaves out what the client cannot send and fills nested references', () => {
    const { spec } = example('store')
    const order = spec.resources.find((resource) => resource.name === 'Order')!
    const { sample } = sampleBody(spec, order, 0)
    expect(Object.keys(sample.body)).toEqual(['customerId', 'lines', 'status', 'total', 'notes'])
    expect(sample.body.lines).toEqual([{ productId: null, quantity: 1.5, unitPrice: 1.5 }])
    expect(sample.references).toEqual([
      { path: ['customerId'], resource: 'Customer' },
      { path: ['lines', 0, 'productId'], resource: 'Product' },
    ])
    const customer = sampleBody(spec, spec.resources[0], 0).sample.body
    expect(customer).toMatchObject({ email: 'email 1', password: 'password 1', address: { street: 'street 1', city: 'city 1' } })
  })

  it('respects lengths and ranges', () => {
    const { spec } = example('catalog')
    const item = spec.resources.find((resource) => resource.name === 'Item')!
    expect(sampleBody(spec, item, 0).sample.body).toMatchObject({ name: 'name 1', price: 0, supplierEmail: 'user1@example.com', stock: 0 })
    expect(sampleBody(spec, spec.resources[0], 0).sample.body).toEqual({ name: 'name 1' })
  })

  it('explains why no body can be built', () => {
    const { spec } = example('library')
    const book = spec.resources.find((resource) => resource.name === 'Book')!
    const odd = {
      ...book,
      fields: book.fields.map((field) => (field.wire === 'isbn' ? { ...field, constraints: { pattern: '^(?!0).+$' } } : field)),
    }
    expect(sampleBody(spec, odd, 0).problem).toMatch(/^No valid sample body could be built \(pattern/)
  })
})

describe('creation helpers', () => {
  it('orders the resources a resource needs, deepest first', () => {
    const { spec } = example('store')
    expect(creationOrder(spec, spec.resources[2]).map((resource) => resource.name)).toEqual(['Customer', 'Product'])
    expect(creationOrder(spec, spec.resources[0])).toEqual([])
  })

  it('picks a plain field to change in a partial update', () => {
    const { spec } = example('store')
    expect(updatableField(spec.resources[0])!.wire).toBe('name')
    expect(updatableField(spec.resources[2])!.wire).toBe('total')
  })
})
