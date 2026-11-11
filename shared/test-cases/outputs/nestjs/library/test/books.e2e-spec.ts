/**
 * Tests of the books endpoints.
 */

import type { Server } from 'node:http'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configure } from '../src/app.setup'
import { bookPayload, createBook, headers } from './helpers'

describe('books', () => {
  let app: INestApplication
  let server: Server

  // A new application per test: every test starts with empty storage
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = configure(moduleRef.createNestApplication())
    await app.init()
    server = app.getHttpServer()
  })

  afterEach(async () => {
    await app.close()
  })

  it('creates a book', async () => {
    const payload = await bookPayload(server, headers)
    const response = await request(server).post('/books').set(headers).send(payload)
    expect(response.status).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.title).toEqual(payload.title)
    expect(response.body.isbn).toEqual(payload.isbn)
    expect(response.body.genre).toEqual(payload.genre)
    expect(response.body.pages).toEqual(payload.pages)
    expect(response.body.available).toEqual(payload.available)
  })

  it('rejects a book without title', async () => {
    const payload = await bookPayload(server, headers)
    delete payload['title']
    const response = await request(server).post('/books').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'title')).toBe(true)
  })

  it('gets a book', async () => {
    const created = await createBook(server, headers)
    const key = created['id']
    const response = await request(server).get(`/books/${key}`).set(headers)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing book', async () => {
    const response = await request(server).get('/books/00000000-0000-0000-0000-000000000000').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists books', async () => {
    await createBook(server, headers)
    await createBook(server, headers, 1)
    const response = await request(server).get('/books').set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists books by page', async () => {
    await createBook(server, headers)
    await createBook(server, headers, 1)
    const response = await request(server).get('/books').query({ page: 2, size: 1 }).set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(server).get('/books').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces a book', async () => {
    const created = await createBook(server, headers)
    const key = created['id']
    const payload = await bookPayload(server, headers, 1)
    const response = await request(server).put(`/books/${key}`).set(headers).send(payload)
    expect(response.status).toBe(200)
    expect(response.body.title).toEqual(payload.title)
    expect(response.body.isbn).toEqual(payload.isbn)
    expect(response.body.genre).toEqual(payload.genre)
    expect(response.body.pages).toEqual(payload.pages)
    expect(response.body.available).toEqual(payload.available)
  })

  it('updates part of a book', async () => {
    const created = await createBook(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/books/${key}`).set(headers).send({ 'title': 'title 2' })
    expect(response.status).toBe(200)
    expect(response.body.title).toEqual('title 2')
  })

  it('rejects null for title', async () => {
    const created = await createBook(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/books/${key}`).set(headers).send({ 'title': null })
    expect(response.status).toBe(400)
  })

  it('deletes a book', async () => {
    const created = await createBook(server, headers)
    const key = created['id']
    const response = await request(server).delete(`/books/${key}`).set(headers)
    expect(response.status).toBe(204)
    expect((await request(server).get(`/books/${key}`).set(headers)).status).toBe(404)
  })
})
