import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../examples/index.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { columnCount, inputLanguage, modelsLanguage, readDatabase, readModels, sourceLabel } from './workspace.ts'

describe('readDatabase', () => {
  it('reads nothing while the input is empty', () => {
    expect(readDatabase({ text: '  ' })).toBeNull()
  })

  it('reads every built-in example into a physical schema', () => {
    for (const example of EXAMPLES) {
      const read = readDatabase({ text: example.text })
      expect(read?.ok, example.id).toBe(true)
      if (read?.ok) expect(columnCount(read.schema)).toBeGreaterThan(0)
    }
  })

  it('reads ORM code when the input is not JSON', () => {
    const text =
      'from sqlalchemy import Column, Integer\n\nclass User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n'
    const read = readDatabase({ text })
    expect(read?.ok).toBe(true)
    if (read?.ok) {
      expect(sourceLabel(read.schema)).toBe('SQLAlchemy')
      expect(read.schema.dialect).toBeNull()
    }
    expect(inputLanguage({ text })).toBe('python')
    expect(inputLanguage({ text: EXAMPLES[0].text })).toBe('json')
  })

  it('reads SQL DDL when the input is neither a project nor ORM code', () => {
    const text = 'CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email VARCHAR(120) NOT NULL UNIQUE\n);\n'
    const read = readDatabase({ text })
    expect(read?.ok).toBe(true)
    if (read?.ok) {
      expect(sourceLabel(read.schema)).toBe('SQL DDL')
      expect(read.schema.dialect).toBe('postgresql')
      expect(read.schema.tables.map((table) => table.name)).toEqual(['users'])
    }
    expect(inputLanguage({ text })).toBe('sql')
    expect(readDatabase({ text: 'CREATE TABLE AS SELECT 1;' })).toEqual({ ok: false, error: 'noTables' })
  })

  it('says why an input cannot be read', () => {
    expect(readDatabase({ text: '{ "a": ' })).toEqual({ ok: false, error: 'notJson' })
    expect(readDatabase({ text: 'export interface User { id: number }' })).toEqual({ ok: false, error: 'unknownInput' })
    expect(readDatabase({ text: 'import sqlalchemy\n' })).toEqual({ ok: false, error: 'noTables' })
  })

  it('reads sample documents of MongoDB, which are JSON too', () => {
    const read = readDatabase({ text: '{ "_id": { "$oid": "65a000000000000000000001" }, "name": "Ana" }', fileName: 'shop.people.json' })
    expect(read?.ok && read.schema.tables.map((table) => [table.name, table.columns.map((column) => column.name)])).toEqual([
      ['people', ['_id', 'name']],
    ])
    expect(read?.ok && sourceLabel(read.schema)).toBe('MongoDB documents')
    // No value of a document goes into the schema
    expect(JSON.stringify(read)).not.toContain('Ana')
    expect(readDatabase({ text: '{ "name": "Ana" }' })?.ok).toBe(false)
  })

  it('names Model2DB projects with their output', () => {
    const read = readDatabase({ text: EXAMPLES[0].text })
    if (read?.ok) expect(sourceLabel(read.schema)).toMatch(/^Model2DB \(/)
  })
})

describe('readModels', () => {
  it('reads classes and DTOs', () => {
    const read = readModels({ text: 'export interface Customer { id: number }', fileName: 'models.ts' })
    expect(read).toMatchObject({ ok: true, format: 'TypeScript' })
  })

  it('reads a Mapper project with the models of both sides and its relations', () => {
    const text = readFileSync(resolve(process.cwd(), '../shared/test-cases/matching/mapper-write/models.mapper.json'), 'utf8')
    const read = readModels({ text, fileName: 'customer.mapper.json' })
    expect(read?.ok && read.project?.root).toBe('CustomerForm->Customer')
    expect(read?.ok && read.schema.models.length).toBe(2)
    expect(modelsLanguage({ text })).toBe('json')
    expect(readModels({ text: text.replace('"version": 1', '"version": 9') })).toEqual({ ok: false, error: 'newerVersion' })
  })
})
