/**
 * Credentials for the tests, builders of valid request bodies, and helpers that create items through the API.
 */

import type { Express } from 'express'
import request from 'supertest'
import { expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = Record<string, any>
export type Headers = Record<string, string>


/** Headers of a client allowed to call every endpoint. */
export const headers: Headers = {}

/** A valid body to create a category, with the items it refers to created first. */
export async function categoryPayload(app: Express, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { name: 'name 1' } : { name: 'name 2' }
  return body
}

/** Creates a category and returns it as the API answers. */
export async function createCategory(app: Express, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(app).post('/categories').set(headers).send(await categoryPayload(app, headers, variant))
  expect(response.status, response.text).toBe(201)
  return response.body
}

/** A valid body to create an item, with the items it refers to created first. */
export async function itemPayload(app: Express, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { name: 'name 1', price: 0, supplierEmail: 'user1@example.com', categoryId: null, stock: 0 } : { name: 'name 2', price: 0.5, supplierEmail: 'user2@example.com', categoryId: null, stock: 1 }
  body['categoryId'] = (await createCategory(app, headers))['id']
  return body
}

/** Creates an item and returns it as the API answers. */
export async function createItem(app: Express, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(app).post('/items').set(headers).send(await itemPayload(app, headers, variant))
  expect(response.status, response.text).toBe(201)
  return response.body
}
