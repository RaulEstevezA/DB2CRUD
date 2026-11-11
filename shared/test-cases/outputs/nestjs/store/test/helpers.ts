/**
 * Credentials for the tests, builders of valid request bodies, and helpers that create items through the API.
 */

import type { Server } from 'node:http'
import request from 'supertest'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = Record<string, any>
export type Headers = Record<string, string>


/** Headers of a client allowed to call every endpoint. */
export const headers: Headers = {}

/** A valid body to create a customer, with the items it refers to created first. */
export async function customerPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { name: 'name 1', email: 'email 1', password: 'password 1', phone: 'phone 1', address: { street: 'street 1', city: 'city 1', postalCode: 'postalCode 1', country: 'country 1' } } : { name: 'name 2', email: 'email 2', password: 'password 2', phone: 'phone 2', address: { street: 'street 2', city: 'city 2', postalCode: 'postalCode 2', country: 'country 2' } }
  return body
}

/** Creates a customer and returns it as the API answers. */
export async function createCustomer(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/customers').set(headers).send(await customerPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}

/** A valid body to create a product, with the items it refers to created first. */
export async function productPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { sku: 'sku 1', name: 'name 1', description: 'description 1', price: 1.5, stock: 1.5, active: true } : { sku: 'sku 2', name: 'name 2', description: 'description 2', price: 2, stock: 2, active: false }
  return body
}

/** Creates a product and returns it as the API answers. */
export async function createProduct(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/products').set(headers).send(await productPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}

/** A valid body to create an order, with the items it refers to created first. */
export async function orderPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { customerId: null, lines: [{ productId: null, quantity: 1.5, unitPrice: 1.5 }], status: 'pending', total: 1.5, notes: 'notes 1' } : { customerId: null, lines: [{ productId: null, quantity: 2, unitPrice: 2 }], status: 'paid', total: 2, notes: 'notes 2' }
  body['customerId'] = (await createCustomer(server, headers))['id']
  body['lines'][0]['productId'] = (await createProduct(server, headers))['id']
  return body
}

/** Creates an order and returns it as the API answers. */
export async function createOrder(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/orders').set(headers).send(await orderPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}
