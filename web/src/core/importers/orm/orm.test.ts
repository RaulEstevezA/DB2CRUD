/**
 * The ORM readers against shared/test-cases/orm/:
 * - model2db/<example>/<orm>/ holds the code Model2DB writes for each example project (scripts/orm-fixtures.mts):
 *   what the reader finds must be what the project says. The code may say more than the project (a length on
 *   the text of an enum); names of constraints, the text of types, navigation names, the difference between
 *   RESTRICT and NO ACTION and whether an enum is a type of the database or a CHECK do not count.
 * - hand/<orm>/<case>/ holds code written by hand.
 * Each folder keeps the schema read from its code in expected.json, which the desktop version must read too.
 *
 * `UPDATE_SHARED=1 npx vitest run src/core/importers/orm/orm.test.ts` writes the expected.json files again from what
 * the web version reads now; the desktop version then has to match them.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../../../examples/index.ts'
import { readModel2DBProject } from '../../interop/model2db/read.ts'
import type { DbSchema, DbType } from '../../schema/types.ts'
import { checkOf } from '../../schema/checks.ts'
import { validateDbSchema } from '../../schema/validate.ts'
import { ORM_READERS, detectOrm, readOrmCode } from './registry.ts'

// Tests run from web/
const FOLDER = resolve(process.cwd(), '../shared/test-cases/orm')
const UPDATE = process.env.UPDATE_SHARED === '1'
const EXPECTED = 'expected.json'

function filesOf(folder: string) {
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]))
  return walk(folder)
    .filter((path) => !path.endsWith(EXPECTED))
    .map((path) => ({ name: relative(folder, path), text: readFileSync(path, 'utf8') }))
}

function readOk(folder: string): DbSchema {
  const read = readOrmCode(filesOf(folder))
  if (!read.ok) throw new Error(`${folder}: ${read.error}`)
  expect(validateDbSchema(read.schema)).toEqual([])
  return read.schema
}

/** What both inputs have to agree on; `project` tells which side may say less. */
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

function comparable(original: DbSchema, originalProject?: DbSchema) {
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

/** The schema is the one kept in expected.json (written again with UPDATE_SHARED=1). */
function matchesExpected(folder: string, schema: DbSchema) {
  const path = join(folder, EXPECTED)
  if (UPDATE) return writeFileSync(path, `${JSON.stringify(schema, null, 1)}\n`)
  expect(schema).toEqual(JSON.parse(readFileSync(path, 'utf8')))
}

const folders = (path: string) =>
  existsSync(path)
    ? readdirSync(path)
        .filter((name) => statSync(join(path, name)).isDirectory())
        .sort()
    : []

// A folder `<reader>.<variant>` holds the code of a variant the same reader reads (jpa.hibernate)
const readerOf = (folder: string) => folder.split('.')[0]

describe('ORM code written by Model2DB', () => {
  for (const example of EXAMPLES)
    for (const orm of folders(join(FOLDER, 'model2db', example.id)))
      it(`${example.id} in ${orm}`, () => {
        const folder = join(FOLDER, 'model2db', example.id, orm)
        expect(detectOrm(filesOf(folder))?.id).toBe(readerOf(orm))
        const expected = readModel2DBProject(example.text)
        if (!expected.ok) throw new Error(expected.error)
        const schema = readOk(folder)
        // Prisma keeps no CHECK constraints, and these folders have no migrations to read them from
        expect(schema.notes.filter((note) => note.code !== 'orm.checksNotKept')).toEqual([])
        expect(comparable(schema, expected.schema)).toEqual(comparable(expected.schema, schema))
        matchesExpected(folder, schema)
      })

  it('has the code of every reader', () => {
    for (const example of EXAMPLES)
      expect([...new Set(folders(join(FOLDER, 'model2db', example.id)).map(readerOf))]).toEqual(
        ORM_READERS.map((reader) => reader.id).sort(),
      )
  })
})

describe('ORM code written by hand', () => {
  for (const orm of folders(join(FOLDER, 'hand')))
    for (const name of folders(join(FOLDER, 'hand', orm)))
      it(`${orm}: ${name}`, () => {
        const folder = join(FOLDER, 'hand', orm, name)
        expect(detectOrm(filesOf(folder))?.id).toBe(orm)
        matchesExpected(folder, readOk(folder))
      })
})

describe('ORM code written by DB2CRUD', () => {
  // The models of every shared project map their tables exactly: they read back as the schema they came from
  const outputs = resolve(process.cwd(), '../shared/test-cases/outputs')
  const models: Record<string, (path: string, text: string) => boolean> = {
    sqlalchemy: (path, text) => path.endsWith('.py') && text.includes('__tablename__'),
    django: (path, text) => path.endsWith('.py') && text.includes('models.Model'),
    prisma: (path) => path.endsWith('.prisma'),
    typeorm: (path, text) => path.endsWith('.ts') && text.includes('@Entity('),
    jpa: (path, text) => path.endsWith('.java') && (text.includes('@Entity') || text.includes('jdbc:')),
    drizzle: (path, text) => path.endsWith('.ts') && !path.startsWith('test') && text.includes("from 'drizzle-orm/"),
    sequelize: (path, text) => path.endsWith('.ts') && !path.startsWith('test') && text.includes("from 'sequelize'"),
  }
  for (const name of readdirSync(outputs).filter((item) => models[item.split('-')[0]]))
    it(name, () => {
      const project = JSON.parse(readFileSync(join(outputs, name), 'utf8')) as { schema: DbSchema; files: Record<string, string> }
      const files = Object.entries(project.files)
        .filter(([path, text]) => models[name.split('-')[0]](path, text))
        .map(([path, text]) => ({ name: path, text }))
      const read = readOrmCode(files)
      if (!read.ok) throw new Error(read.error)
      // Django needs a key: DB2CRUD gives a table without one a key that lives only in an unmanaged model, and says so
      for (const note of read.schema.notes.filter((item) => item.code === 'orm.unmanagedTable')) {
        const table = read.schema.tables.find((item) => item.name === note.params?.table)!
        expect(project.schema.tables.find((item) => item.name === table.name)?.primaryKey).toBeNull()
        table.primaryKey = null
      }
      // JPA needs a key on every entity: DB2CRUD gives a table without one a key of all its columns, which the code
      // cannot tell from a real one
      if (name.startsWith('jpa-'))
        for (const table of read.schema.tables)
          if (
            project.schema.tables.find((item) => item.name === table.name)?.primaryKey === null &&
            table.primaryKey?.length === table.columns.length
          )
            table.primaryKey = null
      // JPA needs a key on every entity: DB2CRUD gives a table without one a key of all its columns, which the code
      // cannot tell from a real one
      if (name.startsWith('jpa-'))
        for (const table of read.schema.tables)
          if (
            project.schema.tables.find((item) => item.name === table.name)?.primaryKey === null &&
            table.primaryKey?.length === table.columns.length
          )
            table.primaryKey = null
      // Prisma keeps no CHECK constraints (DB2CRUD leaves them in a comment), and without migrations they are not read
      const expected = structuredClone(project.schema)
      if (read.schema.notes.some((note) => note.code === 'orm.checksNotKept')) for (const table of expected.tables) table.checks = []
      // Code for another engine than the project's has the types of that engine: only the structure has to agree
      // (the engine of the code is the second word of the name of the output: typeorm-mysql-…)
      const sameEngine = name.split('-')[1] === expected.dialect
      const shape = (schema: ReturnType<typeof comparable>) =>
        sameEngine
          ? schema
          : {
              ...schema,
              tables: schema.tables.map((table) => ({ ...table, columns: table.columns.map(({ type: _type, ...rest }) => rest) })),
            }
      expect(shape(comparable(read.schema, expected))).toEqual(shape(comparable(expected, read.schema)))
    })
})

describe('ORM detection', () => {
  it('refuses code it does not know and code with no table', () => {
    expect(readOrmCode([{ name: 'a.py', text: 'print(1)\n' }])).toEqual({ ok: false, error: 'unknownOrm' })
    expect(readOrmCode([{ name: 'a.py', text: 'from sqlalchemy import Column\n' }])).toEqual({ ok: false, error: 'noTables' })
  })
})
