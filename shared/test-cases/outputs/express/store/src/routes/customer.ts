/**
 * Routes of customers: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { CustomerCreate, CustomerUpdate, toCustomer } from '../schemas/customer.js'
import { type CustomerService } from '../services/customer.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.coerce.number().int()

export function customerRoutes(service: CustomerService): Router {
  const router = Router()

  // List customers
  router.get('/customers', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listCustomers({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toCustomer), total, page: query.page, size: query.size })
  })

  // Get a customer
  router.get('/customers/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toCustomer(await service.getCustomer(key)))
  })

  // Create a customer
  router.post('/customers', async (request, response) => {
    const values = CustomerCreate.parse(request.body)
    response.status(201).json(toCustomer(await service.createCustomer(values)))
  })

  // Replace a customer
  router.put('/customers/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = CustomerCreate.parse(request.body)
    response.status(200).json(toCustomer(await service.replaceCustomer(key, values)))
  })

  // Update part of a customer
  router.patch('/customers/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = CustomerUpdate.parse(request.body)
    response.status(200).json(toCustomer(await service.updateCustomer(key, values)))
  })

  // Delete a customer
  router.delete('/customers/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteCustomer(key)
    response.status(204).end()
  })

  return router
}
