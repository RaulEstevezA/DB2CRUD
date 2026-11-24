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
import type { DbSchema } from '../../schema/types.ts'
import { validateDbSchema } from '../../schema/validate.ts'
import { comparable } from '../test/compare.ts'
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
        // Those of documents are not of tables: they have their own folders (hand/)
        ORM_READERS.map((reader) => reader.id)
          .filter((id) => !['mongoose', 'mongodb', 'springdata', 'beanie'].includes(id))
          .sort(),
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
    doctrine: (path) => path.endsWith('.php') && !path.startsWith('tests/'),
    // The copy of the application models is not part of the ORM code
    efcore: (path) =>
      path.endsWith('.cs') &&
      !path.startsWith('tests/') &&
      !path.startsWith('application-models/') &&
      !path.includes('/ApplicationModels/'),
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
      // DB2CRUD's Doctrine entities keep foreign keys as plain columns (the keys are in a comment), and give a table
      // without a key the one Doctrine needs
      if (name.startsWith('doctrine-')) {
        for (const table of project.schema.tables) table.foreignKeys = []
        for (const table of read.schema.tables)
          if (project.schema.tables.find((item) => item.name === table.name)?.primaryKey === null) table.primaryKey = null
      }
      // Prisma keeps no CHECK constraints (DB2CRUD leaves them in a comment), and without migrations they are not read
      const expected = structuredClone(project.schema)
      if (read.schema.notes.some((note) => note.code === 'orm.checksNotKept')) for (const table of expected.tables) table.checks = []
      // Sequelize cannot say a column is computed by the database (DB2CRUD leaves the expression in a comment)
      if (name.startsWith('sequelize-'))
        for (const table of expected.tables)
          for (const column of table.columns)
            if (typeof column.generated === 'object' && column.generated !== null && 'computed' in column.generated)
              column.generated = undefined
      // What some ORMs cannot say of the databases of verification/ddl/
      if (name.includes('-ddl-')) {
        const orm = name.split('-')[0]
        for (const schema of [expected, read.schema])
          for (const table of schema.tables) {
            // The values of an enum are kept by its native type only
            if (['django', 'doctrine', 'jpa', 'efcore'].includes(orm)) schema.enums = []
            // Foreign keys of several columns
            if (['django', 'sequelize'].includes(orm)) table.foreignKeys = table.foreignKeys.filter((key) => key.columns.length === 1)
            // Prisma names the schema of every table when one of them is in another
            if (table.schema === 'public') delete table.schema
            for (const key of table.foreignKeys) if (key.references.schema === 'public') delete key.references.schema
            for (const column of table.columns) {
              if (column.type.kind === 'enum' && ['django', 'doctrine', 'jpa', 'efcore'].includes(orm))
                column.type = { sql: '', kind: 'text' }
              if (column.generated === 'onUpdateNow') column.generated = 'now'
              if (column.generated === 'uuid') column.generated = undefined
              if (['prisma', 'sequelize'].includes(orm) && typeof column.generated === 'object') column.generated = undefined
              // Prisma has no null lists
              if (orm === 'prisma' && column.type.kind === 'array') column.nullable = false
            }
          }
      }
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
