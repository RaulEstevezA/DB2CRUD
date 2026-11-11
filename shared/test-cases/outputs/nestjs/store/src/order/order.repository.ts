/**
 * Storage of orders.
 */

import { type ListQuery, type ListResult } from '../common/listing'
import { type OrderRecord } from './order.dto'

/** Injection token of the storage of orders. */
export const ORDER_REPOSITORY = Symbol('OrderRepository')

/** Where orders are kept. The service depends only on this interface. */
export interface OrderRepository {
  list(query: ListQuery): Promise<ListResult<OrderRecord>>
  get(key: number): Promise<OrderRecord | undefined>
  add(values: Omit<OrderRecord, 'id'>): Promise<OrderRecord>
  update(key: number, values: Partial<OrderRecord>): Promise<OrderRecord>
  delete(key: number): Promise<void>
}

/** Keeps orders in memory: they are lost when the application stops. Use it to try the API. */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly items = new Map<number, OrderRecord>()
  private nextKey = 1

  async list(query: ListQuery): Promise<ListResult<OrderRecord>> {
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

  async get(key: number): Promise<OrderRecord | undefined> {
    const item = this.items.get(key)
    return item === undefined ? undefined : structuredClone(item)
  }

  async add(values: Omit<OrderRecord, 'id'>): Promise<OrderRecord> {
    const record = { ...structuredClone(values), id: this.nextKey++ } as OrderRecord
    this.items.set(record.id, record)
    return structuredClone(record)
  }

  async update(key: number, values: Partial<OrderRecord>): Promise<OrderRecord> {
    const record = { ...this.items.get(key)!, ...structuredClone(values) }
    this.items.set(key, record)
    return structuredClone(record)
  }

  async delete(key: number): Promise<void> {
    this.items.delete(key)
  }
}
