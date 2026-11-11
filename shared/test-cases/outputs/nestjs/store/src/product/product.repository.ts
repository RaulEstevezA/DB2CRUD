/**
 * Storage of products.
 */

import { type ListQuery, type ListResult } from '../common/listing'
import { type ProductRecord } from './product.dto'

/** Injection token of the storage of products. */
export const PRODUCT_REPOSITORY = Symbol('ProductRepository')

/** Where products are kept. The service depends only on this interface. */
export interface ProductRepository {
  list(query: ListQuery): Promise<ListResult<ProductRecord>>
  get(key: number): Promise<ProductRecord | undefined>
  add(values: Omit<ProductRecord, 'id'>): Promise<ProductRecord>
  update(key: number, values: Partial<ProductRecord>): Promise<ProductRecord>
  delete(key: number): Promise<void>
}

/** Keeps products in memory: they are lost when the application stops. Use it to try the API. */
export class InMemoryProductRepository implements ProductRepository {
  private readonly items = new Map<number, ProductRecord>()
  private nextKey = 1

  async list(query: ListQuery): Promise<ListResult<ProductRecord>> {
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

  async get(key: number): Promise<ProductRecord | undefined> {
    const item = this.items.get(key)
    return item === undefined ? undefined : structuredClone(item)
  }

  async add(values: Omit<ProductRecord, 'id'>): Promise<ProductRecord> {
    const record = { ...structuredClone(values), id: this.nextKey++ } as ProductRecord
    this.items.set(record.id, record)
    return structuredClone(record)
  }

  async update(key: number, values: Partial<ProductRecord>): Promise<ProductRecord> {
    const record = { ...this.items.get(key)!, ...structuredClone(values) }
    this.items.set(key, record)
    return structuredClone(record)
  }

  async delete(key: number): Promise<void> {
    this.items.delete(key)
  }
}
