/**
 * Request and response shapes of books.
 */

import { z } from 'zod'
import { Genre } from './shared.js'

/** Body of a request that creates or replaces a book. */
export const BookCreate = z.strictObject({
  title: z.string().min(1).max(200),
  isbn: z.string().regex(new RegExp('^[0-9]{13}$')),
  authorId: z.uuid(),
  genre: Genre,
  pages: z.number().int().min(1).max(5000),
  published: z.iso.date().nullable().default(null),
  available: z.boolean().default(true),
})
export type BookCreate = z.infer<typeof BookCreate>

/** Body of a request that changes part of a book: only the fields sent change. */
export const BookUpdate = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  isbn: z.string().regex(new RegExp('^[0-9]{13}$')).optional(),
  authorId: z.uuid().optional(),
  genre: Genre.optional(),
  pages: z.number().int().min(1).max(5000).optional(),
  published: z.iso.date().nullable().optional(),
  available: z.boolean().optional(),
})
export type BookUpdate = z.infer<typeof BookUpdate>

/** A book as the repositories keep it: what clients send and what the server fills. */
export type BookRecord = BookCreate & {
  id: string
}

/** A book as the API returns it. */
export type Book = BookRecord

/** The response of a stored book. */
export function toBook(record: BookRecord): Book {
  return record
}
