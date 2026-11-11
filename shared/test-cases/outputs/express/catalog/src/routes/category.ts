/**
 * Routes of categories: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { CategoryCreate, CategoryUpdate, toCategory } from '../schemas/category.js'
import { type CategoryService } from '../services/category.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.coerce.number().int()

export function categoryRoutes(service: CategoryService): Router {
  const router = Router()

  // List categories
  router.get('/categories', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listCategories({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toCategory), total, page: query.page, size: query.size })
  })

  // Get a category
  router.get('/categories/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toCategory(await service.getCategory(key)))
  })

  // Create a category
  router.post('/categories', async (request, response) => {
    const values = CategoryCreate.parse(request.body)
    response.status(201).json(toCategory(await service.createCategory(values)))
  })

  // Replace a category
  router.put('/categories/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = CategoryCreate.parse(request.body)
    response.status(200).json(toCategory(await service.replaceCategory(key, values)))
  })

  // Update part of a category
  router.patch('/categories/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = CategoryUpdate.parse(request.body)
    response.status(200).json(toCategory(await service.updateCategory(key, values)))
  })

  // Delete a category
  router.delete('/categories/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteCategory(key)
    response.status(204).end()
  })

  return router
}
