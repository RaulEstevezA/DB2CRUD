/**
 * Tests of the resolved API: every decision of the design applied once, for the contract and the code.
 */
import { describe, expect, it } from 'vitest'
import { example } from '../test/fixtures.ts'
import { decide, updateEndpoint } from '../design/edit.ts'
import { reconcile } from '../design/propose.ts'

const field = (spec: ReturnType<typeof example>['spec'], resource: string, wire: string) =>
  spec.resources.find((item) => item.name === resource)!.fields.find((item) => item.wire === wire)!

describe('resolveApi', () => {
  it('lists resources, embedded objects and enums', () => {
    const { spec } = example('store')
    expect(spec.resources.map((resource) => resource.name)).toEqual(['Customer', 'Product', 'Order'])
    expect(spec.objects.map((object) => object.name)).toEqual(['Address', 'OrderLine'])
    expect(spec.enums).toEqual([{ name: 'OrderStatus', values: ['pending', 'paid', 'shipped', 'cancelled'], valueType: 'string' }])
    expect(spec.issues).toEqual([])
  })

  it('resolves keys: a number key is a whole number the server increments', () => {
    const { spec } = example('store')
    expect(spec.resources[0].key).toEqual({ field: 'id', type: { kind: 'scalar', scalar: 'integer' }, generated: 'increment', param: 'id' })
    expect(example('library').spec.resources[0].key.generated).toBe('uuid')
  })

  it('sends references as keys and embeds value objects', () => {
    const { spec } = example('store')
    expect(field(spec, 'Order', 'customerId')).toMatchObject({
      name: 'customer',
      reference: 'Customer',
      type: { scalar: 'integer' },
      required: true,
    })
    expect(field(spec, 'Order', 'lines').type).toEqual({ kind: 'array', items: { kind: 'object', name: 'OrderLine' } })
    expect(spec.objects[1].fields.map((item) => item.wire)).toEqual(['productId', 'quantity', 'unitPrice'])
  })

  it('applies access, server values and validations', () => {
    const { spec } = example('store')
    expect(field(spec, 'Customer', 'password').access).toBe('writeOnly')
    expect(field(spec, 'Customer', 'createdAt')).toMatchObject({ access: 'readOnly', server: 'created' })
    expect(field(spec, 'Order', 'updatedAt').server).toBe('updated')
    const library = example('library').spec
    expect(field(library, 'Book', 'isbn').constraints).toEqual({ pattern: '^[0-9]{13}$' })
    expect(field(library, 'Book', 'available')).toMatchObject({ required: false, defaultValue: true })
  })

  it('never requires a reference to the own model, and never sends the key as null', () => {
    const { spec } = example('catalog')
    expect(field(spec, 'Category', 'parentId')).toMatchObject({ required: false, nullable: true, reference: 'Category' })
    expect(field(spec, 'Category', 'id').nullable).toBe(false)
  })

  it('resolves endpoints: status, parameters and protection', () => {
    const { spec } = example('store', { auth: 'jwt', defaultAccess: 'public' })
    const endpoints = spec.resources[0].endpoints
    expect(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.status}`)).toEqual([
      'GET /customers 200',
      'GET /customers/{id} 200',
      'POST /customers 201',
      'PUT /customers/{id} 200',
      'PATCH /customers/{id} 200',
      'DELETE /customers/{id} 204',
    ])
    expect(endpoints[1].pathParams).toEqual([{ name: 'id', type: { kind: 'scalar', scalar: 'integer' } }])
    expect(endpoints.every((endpoint) => endpoint.access === 'public')).toBe(true)
    expect(example('store', { auth: 'none' }).spec.resources[0].endpoints[0].access).toBe('public')
  })

  it('names filters and sort fields by their wire names, and lists the roles', () => {
    const { spec } = example('store', { auth: 'jwt' }, (design) =>
      updateEndpoint(design, 'Order', 'Order.list', {
        filters: ['customer', 'status'],
        sort: ['createdAt'],
        access: 'roles',
        roles: ['admin', 'staff'],
      }),
    )
    const list = spec.resources[2].endpoints[0]
    expect(list).toMatchObject({ filters: ['customerId', 'status'], sort: ['createdAt'], access: 'roles', roles: ['admin', 'staff'] })
    expect(spec.roles).toEqual(['admin', 'staff'])
  })

  it('leaves out endpoints with an error and reports it', () => {
    const { spec } = example('store', {}, (design) => updateEndpoint(design, 'Product', 'Product.get', { path: '/products' }))
    expect(spec.resources[1].endpoints.map((endpoint) => endpoint.operation)).toEqual(['list', 'create', 'replace', 'update', 'delete'])
    expect(spec.issues.map((issue) => issue.code)).toEqual(['missingKeyParam', 'duplicateRoute'])
  })

  it('adds a generated id and a TODO when the key is still to decide', () => {
    const { spec } = example('store', {}, (design) => decide(design, { kind: 'expose', model: 'OrderLine' }, 'resource'))
    const fixture = example('store', {}, (design) => design)
    const reconciled = reconcile(decide(fixture.design, { kind: 'expose', model: 'Address' }, 'resource'), fixture.schema)
    expect(spec.resources.map((resource) => resource.name)).toContain('Customer')
    const address = example('store', {}, () => reconciled).spec.resources.find((resource) => resource.name === 'Address')!
    expect(address.fields[0]).toMatchObject({ name: 'id', access: 'readOnly', server: 'key' })
    expect(address.todo).toMatch(/^Decide the key of Address/)
    expect(field(example('store', {}, () => reconciled).spec, 'Customer', 'addressId').reference).toBe('Address')
  })
})
