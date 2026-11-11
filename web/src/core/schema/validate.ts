/**
 * Consistency checks on a physical schema, whichever importer wrote it: names that repeat, keys, indexes
 * and checks on columns that do not exist, foreign keys to missing tables or columns, and enums that are
 * not declared. Errors make the schema unusable for the tables they name; warnings are shown and the
 * rules go on.
 */
import { findColumn, findTable, isUniqueKey, type DbSchema, type DbTable, type DbType } from './types.ts'

export type SchemaIssueCode =
  | 'duplicateTable'
  | 'duplicateColumn'
  | 'noColumns'
  | 'unknownColumn'
  | 'unknownTable'
  | 'foreignKeyArity'
  | 'foreignKeyNotUnique'
  | 'unknownEnum'

export interface SchemaIssue {
  code: SchemaIssueCode
  severity: 'error' | 'warning'
  table: string
  params: Record<string, string>
}

/** Where a list of columns is used, for the messages: `primary key`, `index ix_name`. */
type Place = 'primaryKey' | 'foreignKey' | 'unique' | 'index' | 'check'

function qualified(table: DbTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name
}

function enumNames(type: DbType): string[] {
  if (type.kind === 'enum') return [type.name]
  if (type.kind === 'array') return enumNames(type.items)
  return []
}

/** Every problem of the schema, table by table in the order of the input. */
export function validateDbSchema(schema: DbSchema): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  const seenTables = new Set<string>()
  const enums = new Set(schema.enums.map((item) => item.name))

  for (const table of schema.tables) {
    const name = qualified(table)
    const issue = (code: SchemaIssueCode, severity: SchemaIssue['severity'], params: Record<string, string> = {}) =>
      issues.push({ code, severity, table: name, params })

    if (seenTables.has(name)) issue('duplicateTable', 'error')
    seenTables.add(name)
    if (table.columns.length === 0) issue('noColumns', 'error')

    const seenColumns = new Set<string>()
    for (const column of table.columns) {
      if (seenColumns.has(column.name)) issue('duplicateColumn', 'error', { column: column.name })
      seenColumns.add(column.name)
      for (const enumName of enumNames(column.type))
        if (!enums.has(enumName)) issue('unknownEnum', 'error', { column: column.name, enum: enumName })
    }

    const requireColumns = (columns: string[], place: Place, constraint = '') => {
      for (const column of columns) if (!findColumn(table, column)) issue('unknownColumn', 'error', { column, place, constraint })
    }
    if (table.primaryKey) requireColumns(table.primaryKey, 'primaryKey')
    for (const unique of table.uniques) requireColumns(unique.columns, 'unique', unique.name ?? '')
    for (const index of table.indexes) requireColumns(index.columns, 'index', index.name ?? '')
    for (const check of table.checks) if (check.parsed) requireColumns([check.parsed.column], 'check', check.name ?? '')

    for (const key of table.foreignKeys) {
      const constraint = key.name ?? ''
      requireColumns(key.columns, 'foreignKey', constraint)
      const target = findTable(schema, key.references.table, key.references.schema)
      const targetName = key.references.schema ? `${key.references.schema}.${key.references.table}` : key.references.table
      if (!target) {
        issue('unknownTable', 'error', { target: targetName, constraint })
        continue
      }
      if (key.columns.length !== key.references.columns.length) {
        issue('foreignKeyArity', 'error', { target: targetName, constraint })
        continue
      }
      const missing = key.references.columns.filter((column) => !findColumn(target, column))
      for (const column of missing) issue('unknownColumn', 'error', { column, place: 'foreignKey', constraint, target: targetName })
      // Engines require the referenced columns to be a key; an input that says otherwise is reported, not fixed
      if (missing.length === 0 && !isUniqueKey(target, key.references.columns))
        issue('foreignKeyNotUnique', 'warning', { target: targetName, columns: key.references.columns.join(', '), constraint })
    }
  }
  return issues
}
