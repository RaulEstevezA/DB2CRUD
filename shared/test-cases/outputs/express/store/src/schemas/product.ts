/**
 * Request and response shapes of products.
 */

import { z } from 'zod'

/** Body of a request that creates or replaces a product. */
export const ProductCreate = z.strictObject({
  sku: z.string(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number(),
  stock: z.number(),
  active: z.boolean(),
})
export type ProductCreate = z.infer<typeof ProductCreate>

/** Body of a request that changes part of a product: only the fields sent change. */
export const ProductUpdate = z.strictObject({
  sku: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.number().optional(),
  stock: z.number().optional(),
  active: z.boolean().optional(),
})
export type ProductUpdate = z.infer<typeof ProductUpdate>

/** A product as the repositories keep it: what clients send and what the server fills. */
export type ProductRecord = ProductCreate & {
  id: number
}

/** A product as the API returns it. */
export type Product = ProductRecord

/** The response of a stored product. */
export function toProduct(record: ProductRecord): Product {
  return record
}
