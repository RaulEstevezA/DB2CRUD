/**
 * Storage of items.
 */

import { type ListQuery, type ListResult } from '../common/listing'
import { type ItemRecord } from './item.dto'

/** Injection token of the storage of items. */
export const ITEM_REPOSITORY = Symbol('ItemRepository')

/** Where items are kept. The service depends only on this interface. */
export interface ItemRepository {
  list(query: ListQuery): Promise<ListResult<ItemRecord>>
  get(key: number): Promise<ItemRecord | undefined>
  add(values: Omit<ItemRecord, 'id'>): Promise<ItemRecord>
  update(key: number, values: Partial<ItemRecord>): Promise<ItemRecord>
  delete(key: number): Promise<void>
}

/** Keeps items in memory: they are lost when the application stops. Use it to try the API. */
export class InMemoryItemRepository implements ItemRepository {
  private readonly items = new Map<number, ItemRecord>()
  private nextKey = 1

  async list(query: ListQuery): Promise<ListResult<ItemRecord>> {
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

  async get(key: number): Promise<ItemRecord | undefined> {
    const item = this.items.get(key)
    return item === undefined ? undefined : structuredClone(item)
  }

  async add(values: Omit<ItemRecord, 'id'>): Promise<ItemRecord> {
    const record = { ...structuredClone(values), id: this.nextKey++ } as ItemRecord
    this.items.set(record.id, record)
    return structuredClone(record)
  }

  async update(key: number, values: Partial<ItemRecord>): Promise<ItemRecord> {
    const record = { ...this.items.get(key)!, ...structuredClone(values) }
    this.items.set(key, record)
    return structuredClone(record)
  }

  async delete(key: number): Promise<void> {
    this.items.delete(key)
  }
}
