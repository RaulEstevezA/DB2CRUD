/**
 * Tests of the API proposal and of the edits on it.
 */
import { describe, expect, it } from 'vitest'
import { parseInput } from '../importers/registry.ts'
import type { InputFormatId } from '../importers/types.ts'
import type { ModelSchema } from '../model/schema.ts'
import { findFieldDesign, findResource, type ApiDesign } from '../api/types.ts'
import { addCustomEndpoint, decide, pendingDecisions, removeEndpoint, setFieldInclude, setResourcePath, updateEndpoint } from './edit.ts'
import { defaultResourcePath, proposeDesign, reconcile } from './propose.ts'

function schemaOf(text: string, format: InputFormatId = 'typescript'): ModelSchema {
  const outcome = parseInput(text, format)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return outcome.schema
}

const STORE = schemaOf(`
export interface Customer { id: number; name: string; email: string; password: string; createdAt: Date; address: Address }
export interface Address { street: string; city: string }
export interface Order { id: string; customer: Customer; lines: OrderLine[]; tags: Tag[]; extra: Metadata }
export interface OrderLine { product: Product; quantity: number }
export interface Product { sku: string; name: string; price: number }
export interface Tag { id: number; label: string; parent?: Tag }
export interface Note { title: string; body: string }
`)

const value = (design: ApiDesign, model: string, field: string, kind: 'access' | 'relation' | 'unknownType') =>
  findFieldDesign(design, model, field)?.[kind]?.value

describe('proposeDesign', () => {
  const design = proposeDesign(STORE)

  it('makes a resource of each model with a key and embeds value objects', () => {
    expect(findResource(design, 'Customer')!.expose).toMatchObject({ value: 'resource', confidence: 'high' })
    expect(findResource(design, 'Address')!.expose).toMatchObject({ value: 'embedded', confidence: 'probable' })
    expect(findResource(design, 'Product')!.expose.value).toBe('embedded')
  })

  it('proposes a resource without a key as a pending key decision', () => {
    const note = findResource(design, 'Note')!
    expect(note.expose).toMatchObject({ value: 'resource', reasons: [{ code: 'standalone' }] })
    expect(note.key).toMatchObject({ value: { kind: 'generated', type: 'integer' }, status: 'pending' })
    expect(note.key!.options).toContainEqual({ kind: 'field', field: 'title' })
  })

  it('takes the field named id as the key', () => {
    expect(findResource(design, 'Order')!.key).toMatchObject({
      value: { kind: 'field', field: 'id' },
      confidence: 'high',
      status: 'active',
    })
  })

  it('proposes what the client may send or read of each field', () => {
    expect(value(design, 'Customer', 'id', 'access')).toBe('readOnly')
    expect(value(design, 'Customer', 'name', 'access')).toBe('readWrite')
    expect(value(design, 'Customer', 'password', 'access')).toBe('writeOnly')
    expect(value(design, 'Customer', 'createdAt', 'access')).toBe('readOnly')
  })

  it('references resources and embeds values', () => {
    expect(value(design, 'Order', 'customer', 'relation')).toBe('reference')
    expect(value(design, 'Order', 'tags', 'relation')).toBe('reference')
    expect(value(design, 'Order', 'lines', 'relation')).toBe('embedded')
    expect(findFieldDesign(design, 'Order', 'lines')!.relation!.options).toEqual(['embedded'])
    expect(findFieldDesign(design, 'Tag', 'parent')!.relation!.reasons[0].code).toBe('selfReference')
  })

  it('waits for the user on types the input does not define', () => {
    expect(findFieldDesign(design, 'Order', 'extra')!.unknownType).toMatchObject({ value: 'any', status: 'pending' })
    expect(pendingDecisions(design)).toEqual([
      { kind: 'unknownType', model: 'Order', field: 'extra' },
      { kind: 'key', model: 'Note' },
    ])
  })

  it('proposes the six standard endpoints of each resource', () => {
    const endpoints = findResource(design, 'Customer')!.endpoints
    expect(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.name}`)).toEqual([
      'GET /customers listCustomers',
      'GET /customers/{id} getCustomer',
      'POST /customers createCustomer',
      'PUT /customers/{id} replaceCustomer',
      'PATCH /customers/{id} updateCustomer',
      'DELETE /customers/{id} deleteCustomer',
    ])
    expect(endpoints[0]).toMatchObject({ pagination: true, filters: [], sort: [], summary: 'List customers' })
    expect(endpoints[1].summary).toBe('Get a customer')
    expect(findResource(design, 'Address')!.endpoints).toEqual([])
  })

  it('takes keys and generated values declared by an entity framework', () => {
    const jpa = proposeDesign(
      schemaOf(
        '@Entity public class Book { @Id @GeneratedValue private Long id; private String title; @Column(updatable = false) private String isbn; }',
        'java',
      ),
    )
    const book = findResource(jpa, 'Book')!
    expect(book.expose).toMatchObject({ value: 'resource', confidence: 'exact' })
    expect(book.key).toMatchObject({ value: { kind: 'field', field: 'id' }, confidence: 'exact' })
    expect(value(jpa, 'Book', 'id', 'access')).toBe('readOnly')
    expect(findFieldDesign(jpa, 'Book', 'id')!.access.confidence).toBe('exact')
  })
})

describe('defaultResourcePath', () => {
  it('writes the plural in kebab case', () => {
    expect(defaultResourcePath('OrderLine')).toBe('order-lines')
    expect(defaultResourcePath('Category')).toBe('categories')
    expect(defaultResourcePath('Address')).toBe('addresses')
    expect(defaultResourcePath('Person')).toBe('people')
  })
})

describe('edits', () => {
  it('keeps a decision the user made when the design is proposed again', () => {
    const decided = decide(proposeDesign(STORE), { kind: 'key', model: 'Note' }, { kind: 'field', field: 'title' })
    const again = reconcile(decided, STORE)
    expect(findResource(again, 'Note')!.key).toMatchObject({ value: { kind: 'field', field: 'title' }, status: 'active', manual: true })
    expect(findResource(again, 'Note')!.endpoints[1].path).toBe('/notes/{title}')
  })

  it('ignores a value that is not an option', () => {
    const design = proposeDesign(STORE)
    expect(decide(design, { kind: 'relation', model: 'Order', field: 'lines' }, 'reference')).toBe(design)
  })

  it('updates relations when a model becomes a resource', () => {
    const decided = reconcile(decide(proposeDesign(STORE), { kind: 'expose', model: 'Product' }, 'resource'), STORE)
    expect(findResource(decided, 'Product')!.key!.status).toBe('pending')
    expect(findResource(decided, 'Product')!.key!.options).toContainEqual({ kind: 'field', field: 'sku' })
    expect(value(decided, 'OrderLine', 'product', 'relation')).toBe('reference')
  })

  it('moves standard paths with the resource path, but keeps paths the user wrote', () => {
    let design = proposeDesign(STORE)
    design = updateEndpoint(design, 'Customer', 'Customer.get', { path: 'clients/{id}/profile' })
    design = reconcile(setResourcePath(design, 'Customer', '/Clients '), STORE)
    const paths = findResource(design, 'Customer')!.endpoints.map((endpoint) => endpoint.path)
    expect(paths).toEqual(['/Clients', '/clients/{id}/profile', '/Clients', '/Clients/{id}', '/Clients/{id}', '/Clients/{id}'])
  })

  it('never leaves the key out', () => {
    const design = proposeDesign(STORE)
    expect(setFieldInclude(design, 'Customer', 'id', false)).toBe(design)
    expect(findFieldDesign(setFieldInclude(design, 'Customer', 'email', false), 'Customer', 'email')!.include).toBe(false)
  })

  it('adds and removes business endpoints, but only disables standard ones', () => {
    const added = addCustomEndpoint(proposeDesign(STORE), 'Order')
    expect(added.id).toBe('Order.custom.1')
    const endpoint = findResource(added.design, 'Order')!.endpoints.at(-1)!
    expect(endpoint).toMatchObject({ operation: 'custom', method: 'POST', path: '/orders/{id}/action', input: 'none', output: 'resource' })
    const kept = reconcile(added.design, STORE)
    expect(findResource(kept, 'Order')!.endpoints).toHaveLength(7)
    expect(findResource(removeEndpoint(kept, 'Order', 'Order.custom.1'), 'Order')!.endpoints).toHaveLength(6)
    expect(findResource(removeEndpoint(kept, 'Order', 'Order.get'), 'Order')!.endpoints).toHaveLength(7)
  })
})
