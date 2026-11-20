// Drizzle schema written by Model2DB from Order. Review it, then run `npx drizzle-kit generate`.
import { relations, sql } from 'drizzle-orm'
import { type AnyPgColumn, bigint, boolean, check, doublePrecision, index, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'

export const customers = pgTable('customers', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  password: text('password').notNull(),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  addressStreet: text('address_street').notNull(),
  addressCity: text('address_city').notNull(),
  addressPostalCode: text('address_postal_code').notNull(),
  addressCountry: text('address_country').notNull(),
})

export const products = pgTable('products', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  price: doublePrecision('price').notNull(),
  stock: integer('stock').notNull(),
  active: boolean('active').notNull(),
})

export const orderLines = pgTable('order_lines', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  quantity: integer('quantity').notNull(),
  unitPrice: doublePrecision('unit_price').notNull(),
  productId: bigint('product_id', { mode: 'number' }).notNull().references((): AnyPgColumn => products.id),
  orderId: bigint('order_id', { mode: 'number' }).notNull().references((): AnyPgColumn => orders.id, { onDelete: 'cascade' }),
}, (table) => [
  index('ix_order_lines_product_id').on(table.productId),
  index('ix_order_lines_order_id').on(table.orderId),
])

// TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
export const orders = pgTable('orders', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  status: varchar('status', { length: 20 }).notNull(),
  total: doublePrecision('total').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  customerId: bigint('customer_id', { mode: 'number' }).notNull().references((): AnyPgColumn => customers.id),
}, (table) => [
  index('ix_orders_customer_id').on(table.customerId),
  check('ck_orders_status', sql`${table.status} IN ('pending', 'paid', 'shipped', 'cancelled')`),
])

export const orderLinesRelations = relations(orderLines, ({ one, many }) => ({
  product: one(products, { fields: [orderLines.productId], references: [products.id], relationName: 'OrderLine_product' }),
  order: one(orders, { fields: [orderLines.orderId], references: [orders.id], relationName: 'OrderLine_order' }),
}))

export const ordersRelations = relations(orders, ({ one, many }) => ({
  lines: many(orderLines, { relationName: 'OrderLine_order' }),
  customer: one(customers, { fields: [orders.customerId], references: [customers.id], relationName: 'Order_customer' }),
}))
