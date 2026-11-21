/**
 * The DDL a schema is created with (ddl.ts) reads back as the same schema, on every engine the generators support:
 * the same tables, columns, keys, unique values and checks.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHOP } from '../crud/fixtures.ts'
import { readDdl } from '../importers/ddl/ddl.ts'
import { MATCHING_CASES, readCase } from '../matching/test/cases.ts'
import { createStatements, dropStatements } from './ddl.ts'
import type { DbSchema, Dialect } from './types.ts'

const DIALECTS: Dialect[] = ['postgresql', 'mysql', 'mariadb', 'sqlite']

/** What the DDL keeps of a schema: table and column names, nullability, generated values, keys, uniques, checks. */
const shape = (schema: DbSchema) =>
  schema.tables.map((table) => ({
    name: table.name,
    columns: table.columns.map((column) => ({ name: column.name, nullable: column.nullable, generated: column.generated !== undefined })),
    primaryKey: table.primaryKey,
    foreignKeys: table.foreignKeys.map((key) => [key.columns, key.references.table, key.references.columns]),
    uniques: table.uniques.map((unique) => unique.columns),
    checks: table.checks.filter((check) => check.parsed).length,
  }))

const schemas: [string, DbSchema][] = [
  ['shop', SHOP],
  ...readdirSync(MATCHING_CASES)
    .sort()
    .map((name): [string, DbSchema] => [name, readCase(join(MATCHING_CASES, name)).database]),
]

describe('DDL of a schema', () => {
  for (const [name, schema] of schemas)
    for (const dialect of DIALECTS)
      it(`${name} on ${dialect}`, () => {
        const read = readDdl(`${createStatements(schema, dialect).join(';\n')};`)
        expect(shape(read)).toEqual(shape(schema))
      })

  it('removes the tables the rows of others point to last', () => {
    const drops = dropStatements(SHOP, 'postgresql')
    expect(drops.findIndex((sql) => sql.includes('"order_lines"'))).toBeLessThan(drops.findIndex((sql) => sql.includes('"orders"')))
    expect(dropStatements(SHOP, 'mysql')[0]).toBe('SET FOREIGN_KEY_CHECKS = 0')
  })
})
