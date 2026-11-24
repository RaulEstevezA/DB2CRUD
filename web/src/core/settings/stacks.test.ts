/** A document database is offered the stacks made for it, and a relational one the others. */
import { describe, expect, it } from 'vitest'
import { inputLanguage, readDatabase } from '../../app/workspace.ts'
import { DEFAULT_SETTINGS, normalizeSettings, settingsFor, stacksFor } from './settings.ts'

const VALIDATOR = '{ $jsonSchema: { bsonType: "object", title: "users", properties: { name: { bsonType: "string" } } } }'

describe('stacks and databases', () => {
  it('follow the database that was read', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)
    expect(stacksFor('mongodb').map((stack) => stack.orm)).toEqual(['mongoose'])
    expect(settingsFor('mongodb', settings).database).toBe('mongodb')
    expect(settingsFor('postgresql', settings)).toEqual(settings)
    expect(settingsFor('postgresql', settingsFor('mongodb', settings)).orm).not.toBe('mongoose')
    expect(settingsFor(null, settings)).toEqual(settings)
  })

  it('read one validator', () => {
    const read = readDatabase({ text: VALIDATOR })
    expect(read?.ok && read.schema.tables.map((table) => table.name)).toEqual(['users'])
    expect(inputLanguage({ text: VALIDATOR })).toBe('typescript')
    // Any other object is a Model2DB project
    expect(readDatabase({ text: '{"a": 1}' })?.ok).toBe(false)
  })
})
