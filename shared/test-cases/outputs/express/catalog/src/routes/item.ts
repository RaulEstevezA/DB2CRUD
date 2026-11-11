/**
 * Routes of items: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { ItemCreate, ItemUpdate, toItem } from '../schemas/item.js'
import { type ItemService } from '../services/item.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.coerce.number().int()

export function itemRoutes(service: ItemService): Router {
  const router = Router()

  // List items
  router.get('/items', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listItems({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toItem), total, page: query.page, size: query.size })
  })

  // Get an item
  router.get('/items/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toItem(await service.getItem(key)))
  })

  // Create an item
  router.post('/items', async (request, response) => {
    const values = ItemCreate.parse(request.body)
    response.status(201).json(toItem(await service.createItem(values)))
  })

  // Replace an item
  router.put('/items/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = ItemCreate.parse(request.body)
    response.status(200).json(toItem(await service.replaceItem(key, values)))
  })

  // Update part of an item
  router.patch('/items/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = ItemUpdate.parse(request.body)
    response.status(200).json(toItem(await service.updateItem(key, values)))
  })

  // Delete an item
  router.delete('/items/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteItem(key)
    response.status(204).end()
  })

  return router
}
