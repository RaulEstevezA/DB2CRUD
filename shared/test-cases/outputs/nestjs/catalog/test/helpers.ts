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

/** A valid body to create a category, with the items it refers to created first. */
export async function categoryPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { name: 'name 1' } : { name: 'name 2' }
  return body
}

/** Creates a category and returns it as the API answers. */
export async function createCategory(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/categories').set(headers).send(await categoryPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}

/** A valid body to create an item, with the items it refers to created first. */
export async function itemPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { name: 'name 1', price: 0, supplierEmail: 'user1@example.com', categoryId: null, stock: 0 } : { name: 'name 2', price: 0.5, supplierEmail: 'user2@example.com', categoryId: null, stock: 1 }
  body['categoryId'] = (await createCategory(server, headers))['id']
  return body
}

/** Creates an item and returns it as the API answers. */
export async function createItem(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/items').set(headers).send(await itemPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}
