/**
 * Builds the application: storage, the rules of each resource, its routes and the error format.
 */

import express from 'express'
import { type Express } from 'express'
import { errorHandler, unknownRoute } from './errors.js'
import { InMemoryAuthorRepository } from './repositories/author.js'
import { InMemoryBookRepository } from './repositories/book.js'
import { authorRoutes } from './routes/author.js'
import { bookRoutes } from './routes/book.js'
import { AuthorService } from './services/author.js'
import { BookService } from './services/book.js'

/** A new application with its own storage: tests create one each. */
export function createApp(): Express {
  // Data kept in memory while the application runs; restarting it starts empty
  const authors = new InMemoryAuthorRepository()
  const books = new InMemoryBookRepository()
  const authorService = new AuthorService(authors)
  const bookService = new BookService(books, authors)

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use(authorRoutes(authorService))
  app.use(bookRoutes(bookService))
  app.use(unknownRoute)
  app.use(errorHandler)
  return app
}
