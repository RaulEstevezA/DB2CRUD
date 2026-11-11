/**
 * Routes of authors: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { AuthorCreate, AuthorUpdate, toAuthor } from '../schemas/author.js'
import { type AuthorService } from '../services/author.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.uuid()

export function authorRoutes(service: AuthorService): Router {
  const router = Router()

  // List authors
  router.get('/authors', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listAuthors({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toAuthor), total, page: query.page, size: query.size })
  })

  // Get an author
  router.get('/authors/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toAuthor(await service.getAuthor(key)))
  })

  // Create an author
  router.post('/authors', async (request, response) => {
    const values = AuthorCreate.parse(request.body)
    response.status(201).json(toAuthor(await service.createAuthor(values)))
  })

  // Replace an author
  router.put('/authors/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = AuthorCreate.parse(request.body)
    response.status(200).json(toAuthor(await service.replaceAuthor(key, values)))
  })

  // Update part of an author
  router.patch('/authors/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = AuthorUpdate.parse(request.body)
    response.status(200).json(toAuthor(await service.updateAuthor(key, values)))
  })

  // Delete an author
  router.delete('/authors/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteAuthor(key)
    response.status(204).end()
  })

  return router
}
