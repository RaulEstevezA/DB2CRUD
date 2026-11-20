/**
 * The comparison of a schema read from code or DDL with the schema of the project that code came from, shared by the
 * tests of the ORM and DDL readers.
 */
import { checkOf } from '../../schema/checks.ts'
import type { DbSchema, DbType } from '../../schema/types.ts'

/** The same schema with every native enum kept as text and a CHECK of its values: both say a column takes one of a
 * few values, and some ORMs can only write one of the two (Prisma has no CHECK). */
function enumsAsChecks(schema: DbSchema): DbSchema {
  const copy = structuredClone(schema)
  for (const item of copy.enums) item.storage = 'check'
  for (const table of copy.tables)
    for (const column of table.columns) {
      if (column.type.kind !== 'enum') continue
      const values = copy.enums.find((item) => item.name === (column.type as { name: string }).name)?.values ?? []
      column.type = { sql: '', kind: 'text' }
      table.checks.push(checkOf(`${column.name} IN (${values.map((value) => `'${value}'`).join(', ')})`))
    }
  return copy
}

/** What a schema read from an input and the schema of its project have to agree on; `project` tells which side may say
 * less. Names of constraints, the text of types and navigation names do not count. */
export function comparable(original: DbSchema, originalProject?: DbSchema) {
  const schema = enumsAsChecks(original)
  const project = originalProject && enumsAsChecks(originalProject)
  const type = (value: DbType, other?: DbType): unknown => {
    const { sql: _sql, ...rest } = value
    if (rest.kind === 'array') return { ...rest, items: type(rest.items, other?.kind === 'array' ? other.items : undefined) }
    // The code may give a length the project leaves to the engine
    if ((rest.kind === 'text' || rest.kind === 'binary') && other && other.kind === rest.kind && other.length === undefined)
      delete rest.length
    return rest
  }
  const byName = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => a.name.localeCompare(b.name))
  const columns = (items: string[]) => items.join(',')
  // The enums are not compared by name: a CHECK of their values says the same, and some ORMs name none
  return {
    tables: byName(schema.tables).map((table) => {
      const other = project?.tables.find((item) => item.name === table.name && item.schema === table.schema)
      return {
        name: table.name,
        schema: table.schema,
        comment: table.comment,
        primaryKey: table.primaryKey,
        columns: table.columns.map((column) => {
          const otherColumn = other?.columns.find((item) => item.name === column.name)
          // A null default is no default on a column that takes null
          const nullDefault = column.default?.kind === 'literal' && column.default.value === null
          return {
            name: column.name,
            type: type(column.type, otherColumn?.type),
            nullable: column.nullable,
            default: nullDefault ? undefined : column.default,
            generated: column.generated,
            comment: column.comment,
          }
        }),
        foreignKeys: table.foreignKeys
          // RESTRICT and NO ACTION (the default) both refuse to delete a row others point to; only when they check differs.
          // Tortoise deletes with the row unless told otherwise, so Model2DB writes RESTRICT for the default
          .map((key) => ({
            columns: key.columns,
            references: key.references,
            onDelete: key.onDelete === 'restrict' || key.onDelete === 'no action' ? undefined : key.onDelete,
            onUpdate: key.onUpdate === 'restrict' || key.onUpdate === 'no action' ? undefined : key.onUpdate,
          }))
          .sort((a, b) => columns(a.columns).localeCompare(columns(b.columns))),
        uniques: table.uniques.map((item) => columns(item.columns)).sort(),
        indexes: table.indexes.map((item) => columns(item.columns)).sort(),
        checks: table.checks.map((check) => (check.parsed ? JSON.stringify(check.parsed) : check.sql.replace(/\s+/g, ' '))).sort(),
      }
    }),
  }
}
