/**
 * Tests of the orders endpoints.
 */

import type { Server } from 'node:http'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configure } from '../src/app.setup'
import { createOrder, headers, orderPayload } from './helpers'

describe('orders', () => {
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

  it('creates an order', async () => {
    const payload = await orderPayload(server, headers)
    const response = await request(server).post('/orders').set(headers).send(payload)
    expect(response.status).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.status).toEqual(payload.status)
    expect(response.body.notes).toEqual(payload.notes)
  })

  it('rejects an order without lines', async () => {
    const payload = await orderPayload(server, headers)
    delete payload['lines']
    const response = await request(server).post('/orders').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'lines')).toBe(true)
  })

  it('gets an order', async () => {
    const created = await createOrder(server, headers)
    const key = created['id']
    const response = await request(server).get(`/orders/${key}`).set(headers)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing order', async () => {
    const response = await request(server).get('/orders/999999').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists orders', async () => {
    await createOrder(server, headers)
    await createOrder(server, headers, 1)
    const response = await request(server).get('/orders').set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists orders by page', async () => {
    await createOrder(server, headers)
    await createOrder(server, headers, 1)
    const response = await request(server).get('/orders').query({ page: 2, size: 1 }).set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(server).get('/orders').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces an order', async () => {
    const created = await createOrder(server, headers)
    const key = created['id']
    const payload = await orderPayload(server, headers, 1)
    const response = await request(server).put(`/orders/${key}`).set(headers).send(payload)
    expect(response.status).toBe(200)
    expect(response.body.status).toEqual(payload.status)
    expect(response.body.notes).toEqual(payload.notes)
  })

  it('updates part of an order', async () => {
    const created = await createOrder(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/orders/${key}`).set(headers).send({ 'total': 2 })
    expect(response.status).toBe(200)
    expect(response.body.total).toEqual(2)
  })

  it('rejects null for total', async () => {
    const created = await createOrder(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/orders/${key}`).set(headers).send({ 'total': null })
    expect(response.status).toBe(400)
  })

  it('deletes an order', async () => {
    const created = await createOrder(server, headers)
    const key = created['id']
    const response = await request(server).delete(`/orders/${key}`).set(headers)
    expect(response.status).toBe(204)
    expect((await request(server).get(`/orders/${key}`).set(headers)).status).toBe(404)
  })
})
