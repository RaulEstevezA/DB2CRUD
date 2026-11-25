import { nameWords } from '../model/naming.ts'
import type { FieldDef } from '../model/schema.ts'
import { reason } from './decision.ts'
import type { FieldDesign, QueryDesign, QuerySort } from './types.ts'

/** The queries the application runs on a stored model, which decide its indexes. The model only says
 * which fields exist, not how rows are filtered and ordered, so a query is proposed only where the shape
 * is common (rows of an owner, newest first) and always waits for the user. */

/** Fields a query can use: stored scalar values and references to one other model (their key column). */
export function queryableFields(fields: FieldDef[], decided: FieldDesign[]): string[] {
  return fields
    .filter((field) => {
      const design = decided.find((item) => item.field === field.name)
      if (!design?.include) return false
      if (field.type.kind === 'primitive' || field.type.kind === 'enum') return !design.relation
      return field.type.kind === 'model' && design.relation?.value === 'reference'
    })
    .map((field) => field.name)
}

/** Words of date fields that do not order the rows of an owner. */
const NOT_ORDERING = new Set(['updated', 'modified', 'deleted', 'expires', 'expiry', 'birth', 'born', 'due', 'last'])

/** The date the rows of an owner are read by: `createdAt` first, then any other date that is not an update,
 * a deletion or an expiry. */
function orderingDate(fields: FieldDef[], queryable: string[]): FieldDef | undefined {
  const dates = fields.filter(
    (field) =>
      queryable.includes(field.name) &&
      field.type.kind === 'primitive' &&
      (field.type.name === 'datetime' || field.type.name === 'date') &&
      !nameWords(field.name).some((word) => NOT_ORDERING.has(word)),
  )
  return dates.find((field) => nameWords(field.name).includes('created')) ?? dates[0]
}

/** One query per field that points to an owner (`userId`, `author: User`), when the model has a date
 * to order by: the rows of that owner, newest first. `namedOwner` says whether a scalar field is named
 * after another model's key, for the databases without foreign keys. */
export function proposeQueries(fields: FieldDef[], decided: FieldDesign[], namedOwner: (field: FieldDef) => boolean): QueryDesign[] {
  const queryable = queryableFields(fields, decided)
  const date = orderingDate(fields, queryable)
  if (!date) return []
  const owner = (item: FieldDesign) => {
    if (item.relation) return item.relation.value === 'reference'
    if (item.foreignKey) return item.foreignKey.value !== null
    const field = fields.find((other) => other.name === item.field)
    return field !== undefined && namedOwner(field)
  }
  return decided
    .filter((item) => queryable.includes(item.field) && owner(item))
    .map((item): QueryDesign => ({
      filter: [item.field],
      sort: [{ field: date.name, direction: 'desc' }],
      status: 'pending',
      reasons: [reason('queryByOwner', { field: item.field, sort: date.name })],
    }))
}

/** The fields of a query, filter first. */
export function queryFields(query: Pick<QueryDesign, 'filter' | 'sort'>): string[] {
  return [...query.filter, ...query.sort.map((item) => item.field)]
}

export function sameQuery(a: Pick<QueryDesign, 'filter' | 'sort'>, b: Pick<QueryDesign, 'filter' | 'sort'>): boolean {
  return JSON.stringify([a.filter, a.sort]) === JSON.stringify([b.filter, b.sort])
}

/** A query that still makes sense for these fields: the ones gone are dropped, and so is the query if
 * nothing is left. */
export function keepQuery(query: QueryDesign, queryable: string[]): QueryDesign | null {
  const filter = query.filter.filter((field) => queryable.includes(field))
  const sort = query.sort.filter((item) => queryable.includes(item.field) && !filter.includes(item.field))
  if (filter.length + sort.length === 0) return null
  return filter.length === query.filter.length && sort.length === query.sort.length ? query : { ...query, filter, sort }
}

/** A query written by the user: fields used once, in order, filter before sort. */
export function cleanQuery(filter: string[], sort: QuerySort[]): Pick<QueryDesign, 'filter' | 'sort'> {
  const seen = new Set<string>()
  const once = (field: string) => (seen.has(field) ? false : (seen.add(field), true))
  return { filter: filter.filter(once), sort: sort.filter((item) => once(item.field)) }
}

/** A query in the words of the generated code: `by userId, ordered by createdAt desc`. */
export function describeQuery(query: Pick<QueryDesign, 'filter' | 'sort'>): string {
  const parts: string[] = []
  if (query.filter.length > 0) parts.push(`by ${query.filter.join(', ')}`)
  if (query.sort.length > 0) parts.push(`ordered by ${query.sort.map((item) => `${item.field} ${item.direction}`).join(', ')}`)
  return parts.join(', ')
}
