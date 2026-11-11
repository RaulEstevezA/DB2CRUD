/**
 * Routes of products: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { ProductCreate, ProductUpdate, toProduct } from '../schemas/product.js'
import { type ProductService } from '../services/product.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.coerce.number().int()

export function productRoutes(service: ProductService): Router {
  const router = Router()

  // List products
  router.get('/products', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listProducts({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toProduct), total, page: query.page, size: query.size })
  })

  // Get a product
  router.get('/products/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toProduct(await service.getProduct(key)))
  })

  // Create a product
  router.post('/products', async (request, response) => {
    const values = ProductCreate.parse(request.body)
    response.status(201).json(toProduct(await service.createProduct(values)))
  })

  // Replace a product
  router.put('/products/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = ProductCreate.parse(request.body)
    response.status(200).json(toProduct(await service.replaceProduct(key, values)))
  })

  // Update part of a product
  router.patch('/products/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = ProductUpdate.parse(request.body)
    response.status(200).json(toProduct(await service.updateProduct(key, values)))
  })

  // Delete a product
  router.delete('/products/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteProduct(key)
    response.status(204).end()
  })

  return router
}
