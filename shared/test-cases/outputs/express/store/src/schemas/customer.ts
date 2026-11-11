/**
 * Request and response shapes of customers.
 */

import { z } from 'zod'
import { Address } from './shared.js'

/** Body of a request that creates or replaces a customer. */
export const CustomerCreate = z.strictObject({
  name: z.string(),
  email: z.string(),
  password: z.string(),
  phone: z.string().optional(),
  address: Address,
})
export type CustomerCreate = z.infer<typeof CustomerCreate>

/** Body of a request that changes part of a customer: only the fields sent change. */
export const CustomerUpdate = z.strictObject({
  name: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  phone: z.string().optional(),
  address: Address.optional(),
})
export type CustomerUpdate = z.infer<typeof CustomerUpdate>

/** A customer as the repositories keep it: what clients send and what the server fills. */
export type CustomerRecord = CustomerCreate & {
  id: number
  createdAt: string
}

/** A customer as the API returns it. */
export type Customer = Omit<CustomerRecord, 'password'>

/** The response of a stored customer. */
export function toCustomer(record: CustomerRecord): Customer {
  const { password: _hidden0, ...response } = record
  return response
}
