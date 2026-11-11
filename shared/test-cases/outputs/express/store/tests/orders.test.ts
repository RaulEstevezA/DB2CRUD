/**
 * Tests of the orders endpoints.
 */

import type { Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createOrder, headers, orderPayload } from './helpers.js'

describe('orders', () => {
  let app: Express

  // A new application per test: every test starts with empty storage
  beforeEach(() => {
    app = createApp()
  })

  it('creates an order', async () => {
    const payload = await orderPayload(app, headers)
    const response = await request(app).post('/orders').set(headers).send(payload)
    expect(response.status, response.text).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.status).toEqual(payload.status)
    expect(response.body.notes).toEqual(payload.notes)
  })

  it('rejects an order without lines', async () => {
    const payload = await orderPayload(app, headers)
    delete payload['lines']
    const response = await request(app).post('/orders').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'lines')).toBe(true)
  })

  it('gets an order', async () => {
    const created = await createOrder(app, headers)
    const key = created['id']
    const response = await request(app).get(`/orders/${key}`).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing order', async () => {
    const response = await request(app).get('/orders/999999').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists orders', async () => {
    await createOrder(app, headers)
    await createOrder(app, headers, 1)
    const response = await request(app).get('/orders').set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists orders by page', async () => {
    await createOrder(app, headers)
    await createOrder(app, headers, 1)
    const response = await request(app).get('/orders').query({ page: 2, size: 1 }).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(app).get('/orders').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces an order', async () => {
    const created = await createOrder(app, headers)
    const key = created['id']
    const payload = await orderPayload(app, headers, 1)
    const response = await request(app).put(`/orders/${key}`).set(headers).send(payload)
    expect(response.status, response.text).toBe(200)
    expect(response.body.status).toEqual(payload.status)
    expect(response.body.notes).toEqual(payload.notes)
  })

  it('updates part of an order', async () => {
    const created = await createOrder(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/orders/${key}`).set(headers).send({ 'total': 2 })
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toEqual(2)
  })

  it('rejects null for total', async () => {
    const created = await createOrder(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/orders/${key}`).set(headers).send({ 'total': null })
    expect(response.status).toBe(400)
  })

  it('deletes an order', async () => {
    const created = await createOrder(app, headers)
    const key = created['id']
    const response = await request(app).delete(`/orders/${key}`).set(headers)
    expect(response.status, response.text).toBe(204)
    expect((await request(app).get(`/orders/${key}`).set(headers)).status).toBe(404)
  })
})
