/**
 * Tests of the items endpoints.
 */

import type { Server } from 'node:http'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configure } from '../src/app.setup'
import { createItem, headers, itemPayload } from './helpers'

describe('items', () => {
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

  it('creates an item', async () => {
    const payload = await itemPayload(server, headers)
    const response = await request(server).post('/items').set(headers).send(payload)
    expect(response.status).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.name).toEqual(payload.name)
    expect(response.body.stock).toEqual(payload.stock)
  })

  it('rejects an item without name', async () => {
    const payload = await itemPayload(server, headers)
    delete payload['name']
    const response = await request(server).post('/items').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'name')).toBe(true)
  })

  it('gets an item', async () => {
    const created = await createItem(server, headers)
    const key = created['id']
    const response = await request(server).get(`/items/${key}`).set(headers)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing item', async () => {
    const response = await request(server).get('/items/999999').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists items', async () => {
    await createItem(server, headers)
    await createItem(server, headers, 1)
    const response = await request(server).get('/items').set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists items by page', async () => {
    await createItem(server, headers)
    await createItem(server, headers, 1)
    const response = await request(server).get('/items').query({ page: 2, size: 1 }).set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(server).get('/items').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces an item', async () => {
    const created = await createItem(server, headers)
    const key = created['id']
    const payload = await itemPayload(server, headers, 1)
    const response = await request(server).put(`/items/${key}`).set(headers).send(payload)
    expect(response.status).toBe(200)
    expect(response.body.name).toEqual(payload.name)
    expect(response.body.stock).toEqual(payload.stock)
  })

  it('updates part of an item', async () => {
    const created = await createItem(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/items/${key}`).set(headers).send({ 'name': 'name 2' })
    expect(response.status).toBe(200)
    expect(response.body.name).toEqual('name 2')
  })

  it('rejects null for name', async () => {
    const created = await createItem(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/items/${key}`).set(headers).send({ 'name': null })
    expect(response.status).toBe(400)
  })

  it('deletes an item', async () => {
    const created = await createItem(server, headers)
    const key = created['id']
    const response = await request(server).delete(`/items/${key}`).set(headers)
    expect(response.status).toBe(204)
    expect((await request(server).get(`/items/${key}`).set(headers)).status).toBe(404)
  })
})
