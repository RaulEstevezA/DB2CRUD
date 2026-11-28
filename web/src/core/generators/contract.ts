/**
 * What every generator writes in `crud-contract.json` beyond the operations themselves, the same in every
 * language: the entity a service manages and the fields of its key, and the fields of the entity that each
 * column of `by` is (docs/interoperability.md). CRUD2Controller reads them instead of matching names.
 *
 * Each generator passes how it names a column's field in its language (`attr`, `prop`, `key`).
 */

/** A column of a table as the generators keep it: the column, and its field in the entity. */
interface NamedColumn {
  column: { name: string }
}

/** The entity of a service and the fields of its key. */
export function serviceTarget<C extends NamedColumn>(info: { entity: string; key: C[] }, field: (column: C) => string) {
  return { entity: info.entity, key: info.key.map(field) }
}

/** The field of each column of `by`, in the same order; a column the table does not have keeps its name. */
export function byFields<C extends NamedColumn>(columns: C[], by: string[], field: (column: C) => string): string[] {
  return by.map((name) => {
    const column = columns.find((candidate) => candidate.column.name === name)
    return column ? field(column) : name
  })
}
