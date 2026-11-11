/**
 * Builds the application: storage, the rules of each resource, its routes and the error format.
 */

import express from 'express'
import { type Express } from 'express'
import { errorHandler, unknownRoute } from './errors.js'
import { InMemoryCustomerRepository } from './repositories/customer.js'
import { InMemoryOrderRepository } from './repositories/order.js'
import { InMemoryProductRepository } from './repositories/product.js'
import { customerRoutes } from './routes/customer.js'
import { orderRoutes } from './routes/order.js'
import { productRoutes } from './routes/product.js'
import { CustomerService } from './services/customer.js'
import { OrderService } from './services/order.js'
import { ProductService } from './services/product.js'

/** A new application with its own storage: tests create one each. */
export function createApp(): Express {
  // Data kept in memory while the application runs; restarting it starts empty
  const customers = new InMemoryCustomerRepository()
  const products = new InMemoryProductRepository()
  const orders = new InMemoryOrderRepository()
  const customerService = new CustomerService(customers)
  const productService = new ProductService(products)
  const orderService = new OrderService(orders, customers, products)

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use(customerRoutes(customerService))
  app.use(productRoutes(productService))
  app.use(orderRoutes(orderService))
  app.use(unknownRoute)
  app.use(errorHandler)
  return app
}
