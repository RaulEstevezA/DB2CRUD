import { toSnakeCase } from '../../model/naming.ts'
import { findEnum } from '../../model/schema.ts'
import { columnName, constraintName, freeName, tableName } from '../naming.ts'
import type { PhysicalEnum, Table } from '../types.ts'
import type { RelationalBuild } from './build.ts'
import { enumLength } from './names.ts'

// Databases without enum types of their own: a native enum becomes a CHECK there
const NO_ENUM_TYPES = new Set(['sqlite', 'sqlserver', 'oracle'])

/** The enums the columns use, as the user chose to store them, and their lookup tables. */
export function buildEnums(build: RelationalBuild): { enums: PhysicalEnum[]; lookups: Table[] } {
  const { schema, design, options } = build
  const enums: PhysicalEnum[] = []
  const lookups: Table[] = []
  for (const name of build.enumsUsed) {
    const definition = findEnum(schema, name)
    if (!definition) continue
    const values = definition.values.map((value) => value.value ?? value.name)
    let storage = design.enums.find((item) => item.enum === name)?.storage.value ?? 'check'
    if (storage === 'native' && NO_ENUM_TYPES.has(options.dialect)) {
      build.notes.push({ code: 'nativeEnumAsCheck', params: { enum: name } })
      storage = 'check'
    }
    const sqlName = storage === 'lookup' ? freeName(tableName(name, options.naming), build.usedTables) : toSnakeCase(name)
    enums.push({ name, sqlName, values, storage })
    if (storage === 'lookup') {
      const numeric = values.every((value) => typeof value === 'number')
      const code = columnName('code', options.naming)
      lookups.push({
        name: sqlName,
        kind: 'lookup',
        model: name,
        columns: [
          {
            name: code,
            type: numeric
              ? { kind: 'primitive', name: 'integer', bits: 32 }
              : { kind: 'primitive', name: 'string', length: enumLength(values) },
            nullable: false,
          },
        ],
        primaryKey: [code],
        foreignKeys: [],
        uniques: [],
        indexes: [],
        checks: [],
        todos: [],
      })
    }
  }
  return { enums, lookups }
}

/** The CHECK constraints and lookup foreign keys of every enum column. */
export function constrainEnumColumns(tables: Table[], enums: PhysicalEnum[], lookups: Table[]) {
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.type.kind !== 'enum') continue
      const physical = enums.find((item) => item.name === (column.type as { name: string }).name)
      if (!physical) continue
      if (physical.storage === 'check')
        table.checks.push({ name: constraintName('ck', table.name, [column.name]), column: column.name, values: physical.values })
      if (physical.storage === 'lookup') {
        const lookup = lookups.find((item) => item.name === physical.sqlName)!
        table.foreignKeys.push({
          name: constraintName('fk', table.name, [column.name]),
          columns: [column.name],
          table: lookup.name,
          references: [lookup.primaryKey[0]],
        })
      }
    }
  }
}
