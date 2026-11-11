/**
 * Builds the application: storage, the rules of each resource, its routes and the error format.
 */

import express from 'express'
import { type Express } from 'express'
import { errorHandler, unknownRoute } from './errors.js'
import { InMemoryCategoryRepository } from './repositories/category.js'
import { InMemoryItemRepository } from './repositories/item.js'
import { categoryRoutes } from './routes/category.js'
import { itemRoutes } from './routes/item.js'
import { CategoryService } from './services/category.js'
import { ItemService } from './services/item.js'

/** A new application with its own storage: tests create one each. */
export function createApp(): Express {
  // Data kept in memory while the application runs; restarting it starts empty
  const categories = new InMemoryCategoryRepository()
  const items = new InMemoryItemRepository()
  const categoryService = new CategoryService(categories)
  const itemService = new ItemService(items, categories)

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use(categoryRoutes(categoryService))
  app.use(itemRoutes(itemService))
  app.use(unknownRoute)
  app.use(errorHandler)
  return app
}
