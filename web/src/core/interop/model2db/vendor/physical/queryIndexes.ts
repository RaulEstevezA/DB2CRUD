import { describeQuery, queryFields } from '../design/queries.ts'
import type { QueryDesign } from '../design/types.ts'
import { constraintName, freeName } from './naming.ts'
import type { Index, Note } from './types.ts'

/** Turns the queries of a stored model into indexes, shared by tables and collections: the filter fields
 * first and then the sort fields, each in its order, so one index finds the rows and returns them sorted. */

export interface QueryTarget {
  /** Table or collection name, for the index name */
  name: string
  model: string
  /** The column or document path of a field, or undefined when it has none of its own */
  columnOf: (field: string) => string | undefined
  /** Indexes already there; the query's index replaces the ones it makes useless */
  indexes: Index[]
  /** The primary key and unique constraints: an index they already cover is not added */
  covering: Index[]
  /** A query still waiting for the user */
  pending: (query: string) => void
}

/** Adds the index of every active query. Returns whether any query turned into an index. */
export function addQueryIndexes(target: QueryTarget, queries: QueryDesign[], notes: Note[]): boolean {
  let added = false
  for (const query of queries) {
    const text = describeQuery(query)
    if (query.status === 'pending') {
      target.pending(text)
      continue
    }
    const columns = queryFields(query).map(target.columnOf)
    if (columns.some((column) => column === undefined)) {
      notes.push({ code: 'queryNotIndexed', params: { model: target.model, query: text } })
      continue
    }
    const descending = query.sort.filter((item) => item.direction === 'desc').map((item) => target.columnOf(item.field) as string)
    addIndex(target, columns as string[], descending, query.filter.length, `${target.model} ${text}`)
    added = true
  }
  return added
}

/** Whether `index` starts with `columns` and returns them in the order wanted: the first `equal` columns
 * are compared with a value, so their direction does not matter; the others must keep their directions,
 * or have all of them reversed, since the database reads an index both ways. */
function serves(index: Pick<Index, 'columns' | 'descending'>, columns: string[], descending: string[], equal: number): boolean {
  if (index.columns.length < columns.length || columns.some((column, i) => index.columns[i] !== column)) return false
  const ordered = columns.slice(equal)
  const same = ordered.map((column) => descending.includes(column) === (index.descending?.includes(column) === true))
  return same.every(Boolean) || same.every((value) => !value)
}

function addIndex(target: QueryTarget, columns: string[], descending: string[], equal: number, query: string) {
  if ([...target.covering, ...target.indexes].some((index) => serves(index, columns, descending, equal))) return
  // Plain indexes on the first columns of this one are no longer needed (the index of a foreign key, too)
  for (let i = target.indexes.length - 1; i >= 0; i--) {
    const index = target.indexes[i]
    if (
      !index.unique &&
      index.columns.length < columns.length &&
      serves({ columns, descending }, index.columns, index.descending ?? [], Math.min(equal, index.columns.length))
    )
      target.indexes.splice(i, 1)
  }
  const used = new Set(target.indexes.map((index) => index.name.toLowerCase()))
  target.indexes.push({
    name: freeName(
      constraintName(
        'ix',
        target.name,
        columns.map((column) => column.replace(/\./g, '_')),
      ),
      used,
    ),
    columns,
    unique: false,
    ...(descending.length > 0 ? { descending } : {}),
    query,
  })
}
