/**
 * Request and response shapes of categories.
 */

import { z } from 'zod'

/** Body of a request that creates or replaces a category. */
export const CategoryCreate = z.strictObject({
  name: z.string().min(1).max(80),
  parentId: z.number().int().nullable().optional(),
})
export type CategoryCreate = z.infer<typeof CategoryCreate>

/** Body of a request that changes part of a category: only the fields sent change. */
export const CategoryUpdate = z.strictObject({
  name: z.string().min(1).max(80).optional(),
  parentId: z.number().int().nullable().optional(),
})
export type CategoryUpdate = z.infer<typeof CategoryUpdate>

/** A category as the repositories keep it: what clients send and what the server fills. */
export type CategoryRecord = CategoryCreate & {
  id: number
}

/** A category as the API returns it. */
export type Category = CategoryRecord

/** The response of a stored category. */
export function toCategory(record: CategoryRecord): Category {
  return record
}
