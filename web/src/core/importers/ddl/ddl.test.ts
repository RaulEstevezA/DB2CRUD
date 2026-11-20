/**
 * The DDL reader against shared/test-cases/ddl/:
 * - model2db/<example>/<engine>/schema.sql holds the DDL Model2DB writes for each example project and engine
 *   (scripts/orm-fixtures.mts): what the reader finds must be what the project says, with the types too when the engine
 *   is the project's.
 * - hand/<case>/schema.sql holds DDL written by hand or dumped by pg_dump and mysqldump.
 * Each folder keeps the schema read in expected.json, which the desktop version must read too
 * (`UPDATE_SHARED=1 npx vitest run src/core/importers/ddl/ddl.test.ts` writes them again).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../../../examples/index.ts'
import { readModel2DBProject } from '../../interop/model2db/read.ts'
import type { DbSchema, Dialect } from '../../schema/types.ts'
import { validateDbSchema } from '../../schema/validate.ts'
import { comparable } from '../test/compare.ts'
import { ddlDialect, detectDdl, readDdl } from './ddl.ts'

// Tests run from web/
const FOLDER = resolve(process.cwd(), '../shared/test-cases/ddl')
const UPDATE = process.env.UPDATE_SHARED === '1'
const EXPECTED = 'expected.json'

const folders = (path: string) =>
  existsSync(path)
    ? readdirSync(path)
        .filter((name) => statSync(join(path, name)).isDirectory())
        .sort()
    : []

function matchesExpected(folder: string, schema: DbSchema) {
  const path = join(folder, EXPECTED)
  if (UPDATE) return writeFileSync(path, `${JSON.stringify(schema, null, 1)}\n`)
  expect(schema).toEqual(JSON.parse(readFileSync(path, 'utf8')))
}

/** The schema without the types of its columns: the DDL of another engine than the project's has its own, and may
 * keep a boolean as a number (SQLite). */
const structure = (schema: ReturnType<typeof comparable>) => ({
  ...schema,
  tables: schema.tables.map((table) => ({
    ...table,
    columns: table.columns.map(({ type: _type, ...rest }) => ({
      ...rest,
      default:
        rest.default?.kind === 'literal' && typeof rest.default.value === 'boolean'
          ? { kind: 'literal', value: rest.default.value ? 1 : 0 }
          : rest.default,
    })),
  })),
})

describe('DDL written by Model2DB', () => {
  for (const example of EXAMPLES)
    for (const engine of folders(join(FOLDER, 'model2db', example.id)))
      it(`${example.id} in ${engine}`, () => {
        const folder = join(FOLDER, 'model2db', example.id, engine)
        const text = readFileSync(join(folder, 'schema.sql'), 'utf8')
        expect(detectDdl(text)).toBe(1)
        const schema = readDdl(text, engine as Dialect)
        expect(validateDbSchema(schema)).toEqual([])
        expect(schema.notes).toEqual([])
        const expected = readModel2DBProject(example.text)
        if (!expected.ok) throw new Error(expected.error)
        const read = comparable(schema, expected.schema)
        const project = comparable(expected.schema, schema)
        if (engine === expected.schema.dialect) expect(read).toEqual(project)
        else expect(structure(read)).toEqual(structure(project))
        matchesExpected(folder, schema)
      })
})

describe('DDL written by hand', () => {
  for (const name of folders(join(FOLDER, 'hand')))
    it(name, () => {
      const folder = join(FOLDER, 'hand', name)
      const schema = readDdl(readFileSync(join(folder, 'schema.sql'), 'utf8'))
      expect(validateDbSchema(schema)).toEqual([])
      matchesExpected(folder, schema)
    })
})

describe('DDL detection', () => {
  it('tells the engine from what only it writes', () => {
    expect(ddlDialect('CREATE TABLE t (id SERIAL PRIMARY KEY);')).toBe('postgresql')
    expect(ddlDialect('CREATE TABLE `t` (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;')).toBe('mysql')
    expect(ddlDialect('-- MariaDB dump 10.19\nCREATE TABLE `t` (id INT);')).toBe('mariadb')
    expect(ddlDialect('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);')).toBe('sqlite')
    expect(ddlDialect('CREATE TABLE t (id INT);')).toBeNull()
  })
  it('reads only text that creates a table', () => {
    expect(detectDdl('SELECT 1;')).toBe(0)
    expect(detectDdl('create temporary table t (id int);')).toBe(1)
  })
})
