/**
 * Request and response shapes of authors.
 */

import { z } from 'zod'

/** Body of a request that creates or replaces an author. */
export const AuthorCreate = z.strictObject({
  name: z.string().min(2).max(120),
  email: z.email().nullable().default(null),
  born: z.iso.date().nullable().default(null),
})
export type AuthorCreate = z.infer<typeof AuthorCreate>

/** Body of a request that changes part of an author: only the fields sent change. */
export const AuthorUpdate = z.strictObject({
  name: z.string().min(2).max(120).optional(),
  email: z.email().nullable().optional(),
  born: z.iso.date().nullable().optional(),
})
export type AuthorUpdate = z.infer<typeof AuthorUpdate>

/** An author as the repositories keep it: what clients send and what the server fills. */
export type AuthorRecord = AuthorCreate & {
  id: string
}

/** An author as the API returns it. */
export type Author = AuthorRecord

/** The response of a stored author. */
export function toAuthor(record: AuthorRecord): Author {
  return record
}
