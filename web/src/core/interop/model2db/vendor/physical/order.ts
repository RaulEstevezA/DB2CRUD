import type { ForeignKey, Table } from './types.ts'

/** Tables in an order where each one comes after the tables it refers to; references that close a cycle
 * are returned apart, to be added once every table exists. */
export function orderTables(tables: Table[]): { tables: Table[]; deferred: Map<string, ForeignKey[]> } {
  const byName = new Map(tables.map((table) => [table.name, table]))
  const done = new Set<string>()
  const visiting = new Set<string>()
  const result: Table[] = []
  const deferred = new Map<string, ForeignKey[]>()
  const visit = (table: Table) => {
    if (done.has(table.name)) return
    visiting.add(table.name)
    for (const fk of table.foreignKeys) {
      const target = byName.get(fk.table)
      if (!target || target.name === table.name || done.has(target.name)) continue
      if (visiting.has(target.name)) deferred.set(table.name, [...(deferred.get(table.name) ?? []), fk])
      else visit(target)
    }
    visiting.delete(table.name)
    done.add(table.name)
    result.push(table)
  }
  for (const table of tables) visit(table)
  return { tables: result, deferred }
}
