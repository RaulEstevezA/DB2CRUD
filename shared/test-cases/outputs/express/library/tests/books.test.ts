/**
 * Tests of the books endpoints.
 */

import type { Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { bookPayload, createBook, headers } from './helpers.js'

describe('books', () => {
  let app: Express

  // A new application per test: every test starts with empty storage
  beforeEach(() => {
    app = createApp()
  })

  it('creates a book', async () => {
    const payload = await bookPayload(app, headers)
    const response = await request(app).post('/books').set(headers).send(payload)
    expect(response.status, response.text).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.title).toEqual(payload.title)
    expect(response.body.isbn).toEqual(payload.isbn)
    expect(response.body.genre).toEqual(payload.genre)
    expect(response.body.pages).toEqual(payload.pages)
    expect(response.body.available).toEqual(payload.available)
  })

  it('rejects a book without title', async () => {
    const payload = await bookPayload(app, headers)
    delete payload['title']
    const response = await request(app).post('/books').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'title')).toBe(true)
  })

  it('gets a book', async () => {
    const created = await createBook(app, headers)
    const key = created['id']
    const response = await request(app).get(`/books/${key}`).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing book', async () => {
    const response = await request(app).get('/books/00000000-0000-0000-0000-000000000000').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists books', async () => {
    await createBook(app, headers)
    await createBook(app, headers, 1)
    const response = await request(app).get('/books').set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists books by page', async () => {
    await createBook(app, headers)
    await createBook(app, headers, 1)
    const response = await request(app).get('/books').query({ page: 2, size: 1 }).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(app).get('/books').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces a book', async () => {
    const created = await createBook(app, headers)
    const key = created['id']
    const payload = await bookPayload(app, headers, 1)
    const response = await request(app).put(`/books/${key}`).set(headers).send(payload)
    expect(response.status, response.text).toBe(200)
    expect(response.body.title).toEqual(payload.title)
    expect(response.body.isbn).toEqual(payload.isbn)
    expect(response.body.genre).toEqual(payload.genre)
    expect(response.body.pages).toEqual(payload.pages)
    expect(response.body.available).toEqual(payload.available)
  })

  it('updates part of a book', async () => {
    const created = await createBook(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/books/${key}`).set(headers).send({ 'title': 'title 2' })
    expect(response.status, response.text).toBe(200)
    expect(response.body.title).toEqual('title 2')
  })

  it('rejects null for title', async () => {
    const created = await createBook(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/books/${key}`).set(headers).send({ 'title': null })
    expect(response.status).toBe(400)
  })

  it('deletes a book', async () => {
    const created = await createBook(app, headers)
    const key = created['id']
    const response = await request(app).delete(`/books/${key}`).set(headers)
    expect(response.status, response.text).toBe(204)
    expect((await request(app).get(`/books/${key}`).set(headers)).status).toBe(404)
  })
})
