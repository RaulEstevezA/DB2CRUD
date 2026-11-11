/**
 * Tests of the OpenAPI contract, checked with a validator of the official OpenAPI 3.1 schema.
 */
import { Validator } from '@seriousme/openapi-schema-validator'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { addCustomEndpoint, updateEndpoint } from '../design/edit.ts'
import { example } from '../test/fixtures.ts'
import { buildOpenApi, openApiYaml } from './build.ts'

type Json = Record<string, any>

async function expectValid(document: Json) {
  const validator = new Validator()
  const result = await validator.validate(document)
  expect(result.errors ?? [], JSON.stringify(result.errors, null, 2)).toEqual([])
  expect(result.valid).toBe(true)
}

describe('buildOpenApi', () => {
  it('writes a valid contract for every example and every authentication', async () => {
    for (const id of ['store', 'library', 'catalog'] as const) {
      for (const auth of ['none', 'apiKey', 'jwt'] as const) {
        await expectValid(buildOpenApi(example(id, { auth }).spec, 'http://localhost:8000'))
      }
    }
  })

  it('describes read, create and update schemas that follow the access of each field', () => {
    const document = buildOpenApi(example('store').spec, 'http://localhost:8000') as Json
    const schemas = document.components.schemas
    expect(Object.keys(schemas.Customer.properties)).toEqual(['id', 'name', 'email', 'phone', 'address', 'createdAt'])
    expect(schemas.Customer.required).toEqual(['id', 'name', 'email', 'phone', 'address', 'createdAt'].filter((name) => name !== 'phone'))
    expect(Object.keys(schemas.CustomerCreate.properties)).toEqual(['name', 'email', 'password', 'phone', 'address'])
    expect(schemas.CustomerCreate.required).toEqual(['name', 'email', 'password', 'address'])
    expect(schemas.CustomerUpdate.required).toBeUndefined()
    expect(schemas.Order.properties.customerId).toEqual({ type: 'integer' })
    expect(schemas.Order.properties.notes).toEqual({ type: ['string', 'null'] })
    expect(schemas.Order.properties.lines).toEqual({ type: 'array', items: { $ref: '#/components/schemas/OrderLine' } })
    expect(schemas.OrderStatus).toEqual({ type: 'string', enum: ['pending', 'paid', 'shipped', 'cancelled'] })
  })

  it('keeps the validations declared in the models', () => {
    const schemas = (buildOpenApi(example('library').spec, 'http://localhost:8000') as Json).components.schemas
    expect(schemas.BookCreate.properties.pages).toEqual({ type: 'integer', minimum: 1, maximum: 5000 })
    expect(schemas.AuthorCreate.properties.email).toEqual({ type: ['string', 'null'], format: 'email', default: null })
    expect(schemas.Book.properties.id).toEqual({ type: 'string', format: 'uuid' })
  })

  it('documents status codes, errors and protection of each operation', () => {
    const document = buildOpenApi(example('store', { auth: 'jwt' }).spec, 'http://localhost:3000') as Json
    const item = document.paths['/customers/{id}']
    expect(Object.keys(item.get.responses)).toEqual(['200', '400', '401', '404'])
    expect(Object.keys(item.delete.responses)).toEqual(['204', '400', '401', '404'])
    expect(item.get.security).toEqual([{ bearer: [] }])
    expect(document.paths['/customers'].get.parameters.map((parameter: Json) => parameter.name)).toEqual(['page', 'size'])
    expect(document.components.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } })
  })

  it('documents filters, sorting, roles and business operations', async () => {
    const { spec } = example('store', { auth: 'jwt' }, (design) => {
      const listed = updateEndpoint(design, 'Order', 'Order.list', {
        filters: ['status'],
        sort: ['total'],
        access: 'roles',
        roles: ['staff'],
      })
      return addCustomEndpoint(listed, 'Order').design
    })
    const document = buildOpenApi(spec, 'http://localhost:3000') as Json
    const list = document.paths['/orders'].get
    expect(list.parameters.slice(2)).toEqual([
      { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/OrderStatus' } },
      {
        name: 'sort',
        in: 'query',
        description: 'Field to sort by; a leading "-" sorts in descending order',
        schema: { type: 'string', enum: ['total', '-total'] },
      },
    ])
    expect(list.description).toBe('Requires one of the roles: staff.')
    expect(Object.keys(document.paths['/orders/{id}/action'].post.responses)).toEqual(['200', '400', '401', '404', '501'])
    await expectValid(document)
  })

  it('writes the contract as YAML', () => {
    const yaml = openApiYaml(example('catalog').spec, 'http://localhost:8080')
    expect(yaml.startsWith('openapi: 3.1.0\n')).toBe(true)
    expect(parse(yaml)).toEqual(buildOpenApi(example('catalog').spec, 'http://localhost:8080'))
  })
})
