/**
 * Storage of customers.
 */

import { type ListQuery, type ListResult } from '../common/listing'
import { type CustomerRecord } from './customer.dto'

/** Injection token of the storage of customers. */
export const CUSTOMER_REPOSITORY = Symbol('CustomerRepository')

/** Where customers are kept. The service depends only on this interface. */
export interface CustomerRepository {
  list(query: ListQuery): Promise<ListResult<CustomerRecord>>
  get(key: number): Promise<CustomerRecord | undefined>
  add(values: Omit<CustomerRecord, 'id'>): Promise<CustomerRecord>
  update(key: number, values: Partial<CustomerRecord>): Promise<CustomerRecord>
  delete(key: number): Promise<void>
}

/** Keeps customers in memory: they are lost when the application stops. Use it to try the API. */
export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly items = new Map<number, CustomerRecord>()
  private nextKey = 1

  async list(query: ListQuery): Promise<ListResult<CustomerRecord>> {
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

  async get(key: number): Promise<CustomerRecord | undefined> {
    const item = this.items.get(key)
    return item === undefined ? undefined : structuredClone(item)
  }

  async add(values: Omit<CustomerRecord, 'id'>): Promise<CustomerRecord> {
    const record = { ...structuredClone(values), id: this.nextKey++ } as CustomerRecord
    this.items.set(record.id, record)
    return structuredClone(record)
  }

  async update(key: number, values: Partial<CustomerRecord>): Promise<CustomerRecord> {
    const record = { ...this.items.get(key)!, ...structuredClone(values) }
    this.items.set(key, record)
    return structuredClone(record)
  }

  async delete(key: number): Promise<void> {
    this.items.delete(key)
  }
}
