/**
 * Tests of the consistency checks on a design.
 */
import { describe, expect, it } from 'vitest'
import { example } from '../test/fixtures.ts'
import { addCustomEndpoint, updateEndpoint } from '../design/edit.ts'
import { pathParams, validateDesign } from './design.ts'

function issuesAfter(edit: Parameters<typeof example>[2], settings: Parameters<typeof example>[1] = {}) {
  const fixture = example('store', settings, edit)
  return validateDesign(fixture.design, fixture.schema, fixture.settings).map(
    (issue) => `${issue.severity} ${issue.code} ${issue.endpoint ?? issue.model}`,
  )
}

describe('validateDesign', () => {
  it('finds nothing wrong in a proposal', () => {
    expect(issuesAfter(undefined)).toEqual([])
  })

  it('finds clashing routes and names', () => {
    expect(
      issuesAfter((design) => updateEndpoint(design, 'Product', 'Product.list', { path: '/customers', name: 'listCustomers' })),
    ).toEqual(['error duplicateRoute Product.list', 'error duplicateName Product.list'])
  })

  it('finds names and paths the code cannot use', () => {
    expect(
      issuesAfter((design) => updateEndpoint(design, 'Product', 'Product.get', { name: 'get product', path: '/products/{id}/{id}' })),
    ).toEqual(['error invalidName Product.get', 'error invalidPath Product.get'])
  })

  it('finds parameters that do not belong to the operation', () => {
    expect(issuesAfter((design) => updateEndpoint(design, 'Product', 'Product.list', { path: '/shops/{shop}/products' }))).toEqual([
      'error unexpectedParam Product.list',
    ])
  })

  it('finds filters on fields that cannot be filtered', () => {
    expect(
      issuesAfter((design) => updateEndpoint(design, 'Customer', 'Customer.list', { filters: ['password', 'address', 'name'] })),
    ).toEqual(['error invalidFilter Customer.list'])
  })

  it('finds protection the authentication cannot enforce', () => {
    expect(issuesAfter((design) => updateEndpoint(design, 'Product', 'Product.delete', { access: 'roles', roles: ['admin'] }))).toEqual([
      'warning protectionIgnored Product.delete',
    ])
    expect(
      issuesAfter((design) => updateEndpoint(design, 'Product', 'Product.delete', { access: 'roles', roles: [] }), { auth: 'jwt' }),
    ).toEqual(['error noRoles Product.delete'])
  })

  it('finds a body on a GET and a status that is not a success', () => {
    const edit = (design: Parameters<NonNullable<Parameters<typeof example>[2]>>[0]) => {
      const added = addCustomEndpoint(design, 'Order')
      return updateEndpoint(added.design, 'Order', added.id, { method: 'GET', input: 'resource', status: 404 })
    }
    expect(issuesAfter(edit)).toEqual(['error bodyOnGet Order.custom.1', 'error invalidStatus Order.custom.1'])
  })
})

describe('pathParams', () => {
  it('lists the parameters in order', () => {
    expect(pathParams('/orders/{id}/lines/{line}')).toEqual(['id', 'line'])
    expect(pathParams('/orders')).toEqual([])
  })
})
