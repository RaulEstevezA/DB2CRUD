/**
 * Tests of the categories endpoints.
 */

import type { Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { categoryPayload, createCategory, headers } from './helpers.js'

describe('categories', () => {
  let app: Express

  // A new application per test: every test starts with empty storage
  beforeEach(() => {
    app = createApp()
  })

  it('creates a category', async () => {
    const payload = await categoryPayload(app, headers)
    const response = await request(app).post('/categories').set(headers).send(payload)
    expect(response.status, response.text).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.name).toEqual(payload.name)
  })

  it('rejects a category without name', async () => {
    const payload = await categoryPayload(app, headers)
    delete payload['name']
    const response = await request(app).post('/categories').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'name')).toBe(true)
  })

  it('gets a category', async () => {
    const created = await createCategory(app, headers)
    const key = created['id']
    const response = await request(app).get(`/categories/${key}`).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing category', async () => {
    const response = await request(app).get('/categories/999999').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists categories', async () => {
    await createCategory(app, headers)
    await createCategory(app, headers, 1)
    const response = await request(app).get('/categories').set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists categories by page', async () => {
    await createCategory(app, headers)
    await createCategory(app, headers, 1)
    const response = await request(app).get('/categories').query({ page: 2, size: 1 }).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(app).get('/categories').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces a category', async () => {
    const created = await createCategory(app, headers)
    const key = created['id']
    const payload = await categoryPayload(app, headers, 1)
    const response = await request(app).put(`/categories/${key}`).set(headers).send(payload)
    expect(response.status, response.text).toBe(200)
    expect(response.body.name).toEqual(payload.name)
  })

  it('updates part of a category', async () => {
    const created = await createCategory(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/categories/${key}`).set(headers).send({ 'name': 'name 2' })
    expect(response.status, response.text).toBe(200)
    expect(response.body.name).toEqual('name 2')
  })

  it('rejects null for name', async () => {
    const created = await createCategory(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/categories/${key}`).set(headers).send({ 'name': null })
    expect(response.status).toBe(400)
  })

  it('deletes a category', async () => {
    const created = await createCategory(app, headers)
    const key = created['id']
    const response = await request(app).delete(`/categories/${key}`).set(headers)
    expect(response.status, response.text).toBe(204)
    expect((await request(app).get(`/categories/${key}`).set(headers)).status).toBe(404)
  })
})
