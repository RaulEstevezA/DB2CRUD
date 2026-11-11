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

/** A valid body to create an author, with the items it refers to created first. */
export async function authorPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { name: 'name 1', email: 'user1@example.com', born: '2024-01-15' } : { name: 'name 2', email: 'user2@example.com', born: '2024-01-16' }
  return body
}

/** Creates an author and returns it as the API answers. */
export async function createAuthor(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/authors').set(headers).send(await authorPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}

/** A valid body to create a book, with the items it refers to created first. */
export async function bookPayload(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const body: Body = variant === 0 ? { title: 'title 1', isbn: '0000000000000', authorId: null, genre: 'novel', pages: 1, published: '2024-01-15', available: true } : { title: 'title 2', isbn: '0000000000000', authorId: null, genre: 'essay', pages: 2, published: '2024-01-16', available: false }
  body['authorId'] = (await createAuthor(server, headers))['id']
  return body
}

/** Creates a book and returns it as the API answers. */
export async function createBook(server: Server, headers: Headers, variant = 0): Promise<Body> {
  const response = await request(server).post('/books').set(headers).send(await bookPayload(server, headers, variant))
  expect(response.status).toBe(201)
  return response.body
}
