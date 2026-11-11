/**
 * Tests of the products endpoints.
 */

import type { Server } from 'node:http'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configure } from '../src/app.setup'
import { createProduct, headers, productPayload } from './helpers'

describe('products', () => {
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

  it('creates a product', async () => {
    const payload = await productPayload(server, headers)
    const response = await request(server).post('/products').set(headers).send(payload)
    expect(response.status).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.sku).toEqual(payload.sku)
    expect(response.body.name).toEqual(payload.name)
    expect(response.body.description).toEqual(payload.description)
    expect(response.body.active).toEqual(payload.active)
  })

  it('rejects a product without sku', async () => {
    const payload = await productPayload(server, headers)
    delete payload['sku']
    const response = await request(server).post('/products').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'sku')).toBe(true)
  })

  it('gets a product', async () => {
    const created = await createProduct(server, headers)
    const key = created['id']
    const response = await request(server).get(`/products/${key}`).set(headers)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing product', async () => {
    const response = await request(server).get('/products/999999').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists products', async () => {
    await createProduct(server, headers)
    await createProduct(server, headers, 1)
    const response = await request(server).get('/products').set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists products by page', async () => {
    await createProduct(server, headers)
    await createProduct(server, headers, 1)
    const response = await request(server).get('/products').query({ page: 2, size: 1 }).set(headers)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(server).get('/products').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces a product', async () => {
    const created = await createProduct(server, headers)
    const key = created['id']
    const payload = await productPayload(server, headers, 1)
    const response = await request(server).put(`/products/${key}`).set(headers).send(payload)
    expect(response.status).toBe(200)
    expect(response.body.sku).toEqual(payload.sku)
    expect(response.body.name).toEqual(payload.name)
    expect(response.body.description).toEqual(payload.description)
    expect(response.body.active).toEqual(payload.active)
  })

  it('updates part of a product', async () => {
    const created = await createProduct(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/products/${key}`).set(headers).send({ 'sku': 'sku 2' })
    expect(response.status).toBe(200)
    expect(response.body.sku).toEqual('sku 2')
  })

  it('rejects null for sku', async () => {
    const created = await createProduct(server, headers)
    const key = created['id']
    const response = await request(server).patch(`/products/${key}`).set(headers).send({ 'sku': null })
    expect(response.status).toBe(400)
  })

  it('deletes a product', async () => {
    const created = await createProduct(server, headers)
    const key = created['id']
    const response = await request(server).delete(`/products/${key}`).set(headers)
    expect(response.status).toBe(204)
    expect((await request(server).get(`/products/${key}`).set(headers)).status).toBe(404)
  })
})
