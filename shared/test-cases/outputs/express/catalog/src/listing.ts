/**
 * What a list asks the repositories for: equality filters, an order and a window of items.
 */

export interface ListQuery {
  /** JSON field name → value every item must have */
  filters: Record<string, unknown>
  sort?: { field: string; descending: boolean }
  offset: number
  /** At most this many items; all of them when absent */
  limit?: number
}

export interface ListResult<T> {
  items: T[]
  /** How many items match, whatever the window */
  total: number
}

/** `"-createdAt"` → sort by createdAt, descending. */
export function parseSort(sort: string | undefined): ListQuery['sort'] {
  if (!sort) return undefined
  return sort.startsWith('-') ? { field: sort.slice(1), descending: true } : { field: sort, descending: false }
}
