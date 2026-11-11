/**
 * Enums and embedded objects shared by the resources.
 */

import { z } from 'zod'

/** Values of OrderStatus. */
export const OrderStatus = z.enum(['pending', 'paid', 'shipped', 'cancelled'])
export type OrderStatus = z.infer<typeof OrderStatus>

/** Address, embedded in the resources that hold it. */
export const Address = z.strictObject({
  street: z.string(),
  city: z.string(),
  postalCode: z.string(),
  country: z.string(),
})
export type Address = z.infer<typeof Address>

/** OrderLine, embedded in the resources that hold it. */
export const OrderLine = z.strictObject({
  productId: z.number().int(),
  quantity: z.number(),
  unitPrice: z.number(),
})
export type OrderLine = z.infer<typeof OrderLine>
