/**
 * Storage of books.
 */

import { randomUUID } from 'node:crypto'
import { type ListQuery, type ListResult } from '../common/listing'
import { type BookRecord } from './book.dto'

/** Injection token of the storage of books. */
export const BOOK_REPOSITORY = Symbol('BookRepository')

/** Where books are kept. The service depends only on this interface. */
export interface BookRepository {
  list(query: ListQuery): Promise<ListResult<BookRecord>>
  get(key: string): Promise<BookRecord | undefined>
  add(values: Omit<BookRecord, 'id'>): Promise<BookRecord>
  update(key: string, values: Partial<BookRecord>): Promise<BookRecord>
  delete(key: string): Promise<void>
}

/** Keeps books in memory: they are lost when the application stops. Use it to try the API. */
export class InMemoryBookRepository implements BookRepository {
  private readonly items = new Map<string, BookRecord>()

  async list(query: ListQuery): Promise<ListResult<BookRecord>> {
    const value = (item: unknown, field: string) => (item as Record<string, unknown>)[field]
    let items = [...this.items.values()].filter((item) => Object.entries(query.filters).every(([field, expected]) => value(item, field) === expected))
    if (query.sort) {
      const { field, descending } = query.sort
      // Items without a value go last, whatever the order
      const present = items.filter((item) => value(item, field) != null)
      present.sort((a, b) => {
        const left = value(a, field) as string | number
        const right = value(b, field) as string | number
        const order = left < right ? -1 : left > right ? 1 : 0
        return descending ? -order : order
      })
      items = [...present, ...items.filter((item) => value(item, field) == null)]
    }
    const end = query.limit === undefined ? undefined : query.offset + query.limit
    return { items: items.slice(query.offset, end).map((item) => structuredClone(item)), total: items.length }
  }

  async get(key: string): Promise<BookRecord | undefined> {
    const item = this.items.get(key)
    return item === undefined ? undefined : structuredClone(item)
  }

  async add(values: Omit<BookRecord, 'id'>): Promise<BookRecord> {
    const record = { ...structuredClone(values), id: randomUUID() } as BookRecord
    this.items.set(record.id, record)
    return structuredClone(record)
  }

  async update(key: string, values: Partial<BookRecord>): Promise<BookRecord> {
    const record = { ...this.items.get(key)!, ...structuredClone(values) }
    this.items.set(key, record)
    return structuredClone(record)
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key)
  }
}
