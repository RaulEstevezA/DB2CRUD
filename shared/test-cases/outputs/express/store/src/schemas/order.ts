/**
 * Request and response shapes of orders.
 */

import { z } from 'zod'
import { OrderLine, OrderStatus } from './shared.js'

/** Body of a request that creates or replaces an order. */
export const OrderCreate = z.strictObject({
  customerId: z.number().int(),
  lines: z.array(OrderLine),
  status: OrderStatus,
  total: z.number(),
  notes: z.string().nullable().optional(),
})
export type OrderCreate = z.infer<typeof OrderCreate>

/** Body of a request that changes part of an order: only the fields sent change. */
export const OrderUpdate = z.strictObject({
  customerId: z.number().int().optional(),
  lines: z.array(OrderLine).optional(),
  status: OrderStatus.optional(),
  total: z.number().optional(),
  notes: z.string().nullable().optional(),
})
export type OrderUpdate = z.infer<typeof OrderUpdate>

/** An order as the repositories keep it: what clients send and what the server fills. */
export type OrderRecord = OrderCreate & {
  id: number
  createdAt: string
  updatedAt: string
}

/** An order as the API returns it. */
export type Order = OrderRecord

/** The response of a stored order. */
export function toOrder(record: OrderRecord): Order {
  return record
}
