/**
 * Routes of orders: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { OrderCreate, OrderUpdate, toOrder } from '../schemas/order.js'
import { type OrderService } from '../services/order.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.coerce.number().int()

export function orderRoutes(service: OrderService): Router {
  const router = Router()

  // List orders
  router.get('/orders', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listOrders({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toOrder), total, page: query.page, size: query.size })
  })

  // Get an order
  router.get('/orders/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toOrder(await service.getOrder(key)))
  })

  // Create an order
  router.post('/orders', async (request, response) => {
    const values = OrderCreate.parse(request.body)
    response.status(201).json(toOrder(await service.createOrder(values)))
  })

  // Replace an order
  router.put('/orders/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = OrderCreate.parse(request.body)
    response.status(200).json(toOrder(await service.replaceOrder(key, values)))
  })

  // Update part of an order
  router.patch('/orders/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = OrderUpdate.parse(request.body)
    response.status(200).json(toOrder(await service.updateOrder(key, values)))
  })

  // Delete an order
  router.delete('/orders/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteOrder(key)
    response.status(204).end()
  })

  return router
}
