/**
 * Routes of books: HTTP in, service calls, HTTP out.
 */

import { Router } from 'express'
import { z } from 'zod'
import { parseSort } from '../listing.js'
import { BookCreate, BookUpdate, toBook } from '../schemas/book.js'
import { type BookService } from '../services/book.js'

/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */
const keyParam = z.uuid()

export function bookRoutes(service: BookService): Router {
  const router = Router()

  // List books
  router.get('/books', async (request, response) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query)
    const filters = {}
    const { items, total } = await service.listBooks({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    response.status(200).json({ items: items.map(toBook), total, page: query.page, size: query.size })
  })

  // Get a book
  router.get('/books/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    response.status(200).json(toBook(await service.getBook(key)))
  })

  // Create a book
  router.post('/books', async (request, response) => {
    const values = BookCreate.parse(request.body)
    response.status(201).json(toBook(await service.createBook(values)))
  })

  // Replace a book
  router.put('/books/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = BookCreate.parse(request.body)
    response.status(200).json(toBook(await service.replaceBook(key, values)))
  })

  // Update part of a book
  router.patch('/books/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    const values = BookUpdate.parse(request.body)
    response.status(200).json(toBook(await service.updateBook(key, values)))
  })

  // Delete a book
  router.delete('/books/:id', async (request, response) => {
    const key = keyParam.parse(request.params['id'])
    await service.deleteBook(key)
    response.status(204).end()
  })

  return router
}
