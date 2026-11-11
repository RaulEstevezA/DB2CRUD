/**
 * Tests of the products endpoints.
 */

import type { Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createProduct, headers, productPayload } from './helpers.js'

describe('products', () => {
  let app: Express

  // A new application per test: every test starts with empty storage
  beforeEach(() => {
    app = createApp()
  })

  it('creates a product', async () => {
    const payload = await productPayload(app, headers)
    const response = await request(app).post('/products').set(headers).send(payload)
    expect(response.status, response.text).toBe(201)
    expect(response.body.id).toBeDefined()
    expect(response.body.sku).toEqual(payload.sku)
    expect(response.body.name).toEqual(payload.name)
    expect(response.body.description).toEqual(payload.description)
    expect(response.body.active).toEqual(payload.active)
  })

  it('rejects a product without sku', async () => {
    const payload = await productPayload(app, headers)
    delete payload['sku']
    const response = await request(app).post('/products').set(headers).send(payload)
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
    expect(response.body.error.details.some((detail: { field: string }) => detail.field === 'sku')).toBe(true)
  })

  it('gets a product', async () => {
    const created = await createProduct(app, headers)
    const key = created['id']
    const response = await request(app).get(`/products/${key}`).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body).toEqual(created)
  })

  it('answers 404 for a missing product', async () => {
    const response = await request(app).get('/products/999999').set(headers)
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('lists products', async () => {
    await createProduct(app, headers)
    await createProduct(app, headers, 1)
    const response = await request(app).get('/products').set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.page).toBe(1)
  })

  it('lists products by page', async () => {
    await createProduct(app, headers)
    await createProduct(app, headers, 1)
    const response = await request(app).get('/products').query({ page: 2, size: 1 }).set(headers)
    expect(response.status, response.text).toBe(200)
    expect(response.body.total).toBe(2)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.page).toBe(2)
  })

  it('rejects a page that does not exist', async () => {
    const response = await request(app).get('/products').query({ page: 0 }).set(headers)
    expect(response.status).toBe(400)
  })

  it('replaces a product', async () => {
    const created = await createProduct(app, headers)
    const key = created['id']
    const payload = await productPayload(app, headers, 1)
    const response = await request(app).put(`/products/${key}`).set(headers).send(payload)
    expect(response.status, response.text).toBe(200)
    expect(response.body.sku).toEqual(payload.sku)
    expect(response.body.name).toEqual(payload.name)
    expect(response.body.description).toEqual(payload.description)
    expect(response.body.active).toEqual(payload.active)
  })

  it('updates part of a product', async () => {
    const created = await createProduct(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/products/${key}`).set(headers).send({ 'sku': 'sku 2' })
    expect(response.status, response.text).toBe(200)
    expect(response.body.sku).toEqual('sku 2')
  })

  it('rejects null for sku', async () => {
    const created = await createProduct(app, headers)
    const key = created['id']
    const response = await request(app).patch(`/products/${key}`).set(headers).send({ 'sku': null })
    expect(response.status).toBe(400)
  })

  it('deletes a product', async () => {
    const created = await createProduct(app, headers)
    const key = created['id']
    const response = await request(app).delete(`/products/${key}`).set(headers)
    expect(response.status, response.text).toBe(204)
    expect((await request(app).get(`/products/${key}`).set(headers)).status).toBe(404)
  })
})
