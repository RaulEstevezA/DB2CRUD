/**
 * Request and response shapes of items.
 */

import { z } from 'zod'

/** Body of a request that creates or replaces an item. */
export const ItemCreate = z.strictObject({
  name: z.string().min(3).max(120),
  price: z.number().min(0),
  supplierEmail: z.email(),
  categoryId: z.number().int(),
  stock: z.number().int().min(0),
})
export type ItemCreate = z.infer<typeof ItemCreate>

/** Body of a request that changes part of an item: only the fields sent change. */
export const ItemUpdate = z.strictObject({
  name: z.string().min(3).max(120).optional(),
  price: z.number().min(0).optional(),
  supplierEmail: z.email().optional(),
  categoryId: z.number().int().optional(),
  stock: z.number().int().min(0).optional(),
})
export type ItemUpdate = z.infer<typeof ItemUpdate>

/** An item as the repositories keep it: what clients send and what the server fills. */
export type ItemRecord = ItemCreate & {
  id: number
}

/** An item as the API returns it. */
export type Item = ItemRecord

/** The response of a stored item. */
export function toItem(record: ItemRecord): Item {
  return record
}
