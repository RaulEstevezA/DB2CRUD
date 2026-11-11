/**
 * Storage of authors.
 */

import { randomUUID } from 'node:crypto'
import { type ListQuery, type ListResult } from '../listing.js'
import { type AuthorRecord } from '../schemas/author.js'

/** Where authors are kept. The service depends only on this interface. */
export interface AuthorRepository {
  /** Items equal to every filter, in order, within the window; and how many match. */
  list(query: ListQuery): Promise<ListResult<AuthorRecord>>
  /** The item with this key, or undefined. */
  get(key: string): Promise<AuthorRecord | undefined>
  /** Stores a new item and assigns its key; returns it as stored. */
  add(values: Omit<AuthorRecord, 'id'>): Promise<AuthorRecord>
  /** Changes the given fields of an existing item and returns it. */
  update(key: string, values: Partial<AuthorRecord>): Promise<AuthorRecord>
  /** Removes an existing item. */
  delete(key: string): Promise<void>
}

/** Keeps authors in memory: they are lost when the application stops. Use it to try the API. */
export class InMemoryAuthorRepository implements AuthorRepository {
  private readonly items = new Map<string, AuthorRecord>()

  async list(query: ListQuery): Promise<ListResult<AuthorRecord>> {
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

  async get(key: string): Promise<AuthorRecord | undefined> {
    const item = this.items.get(key)
    return item === undefined ? undefined : structuredClone(item)
  }

  async add(values: Omit<AuthorRecord, 'id'>): Promise<AuthorRecord> {
    const record = { ...structuredClone(values), id: randomUUID() } as AuthorRecord
    this.items.set(record.id, record)
    return structuredClone(record)
  }

  async update(key: string, values: Partial<AuthorRecord>): Promise<AuthorRecord> {
    const record = { ...this.items.get(key)!, ...structuredClone(values) }
    this.items.set(key, record)
    return structuredClone(record)
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key)
  }
}
