/**
 * What the readers of document databases (MongoDB) share: the types of its values and the column every collection
 * has as its key. A collection is a table whose columns are the fields of its documents; a nested document is a
 * `json` column that says its `fields`.
 */
import type { DbColumn, DbType } from './types.ts'

export const OBJECT_ID: DbType = { sql: 'ObjectId', kind: 'text', length: 24, fixed: true, objectId: true }

/** The `_id` MongoDB gives a document that brings none. */
export const idColumn = (): DbColumn => ({ name: '_id', type: OBJECT_ID, nullable: false, generated: 'uuid' })

export const isObjectId = (type: DbType): boolean => type.kind === 'text' && type.objectId === true

/** The fields of a nested document, or of each document of an array of them. */
export function nestedFields(type: DbType): DbColumn[] | undefined {
  if (type.kind === 'array') return nestedFields(type.items)
  return type.kind === 'json' ? type.fields : undefined
}
