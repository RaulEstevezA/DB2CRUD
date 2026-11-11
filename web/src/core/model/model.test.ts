import { describe, expect, it } from 'vitest'
import { nameWords, pluralize, singularize, toCamelCase, toPascalCase, toScreamingSnakeCase, toSnakeCase } from './naming.ts'
import { allFields, defaultRoot, describeType, emptySchema, needsValue, primitive, type FieldDef, type ModelSchema } from './schema.ts'

const field = (name: string, overrides: Partial<FieldDef> = {}): FieldDef => ({
  name,
  type: primitive('string'),
  nullable: false,
  optional: false,
  ...overrides,
})

describe('naming', () => {
  it('splits every convention into the same words', () => {
    for (const name of ['userId', 'user_id', 'UserId', 'userID', 'user-id', 'USER_ID']) expect(nameWords(name)).toEqual(['user', 'id'])
  })

  it('converts between conventions', () => {
    expect(toPascalCase('created_at')).toBe('CreatedAt')
    expect(toCamelCase('created_at')).toBe('createdAt')
    expect(toSnakeCase('createdAt')).toBe('created_at')
    expect(toScreamingSnakeCase('inProgress')).toBe('IN_PROGRESS')
  })

  it('singularizes plurals', () => {
    expect(singularize('items')).toBe('item')
    expect(singularize('addresses')).toBe('address')
    expect(singularize('status')).toBe('status')
  })
})

describe('pluralize', () => {
  it('writes English plurals, keeping the case', () => {
    expect(['Category', 'address', 'box', 'person', 'day', 'data', 'Status', 'ORDER'].map(pluralize)).toEqual([
      'Categories',
      'addresses',
      'boxes',
      'people',
      'days',
      'data',
      'Statuses',
      'ORDERS',
    ])
  })
})

describe('schema helpers', () => {
  const schema: ModelSchema = {
    ...emptySchema(),
    models: [
      { name: 'Address', kind: 'class', fields: [field('city')] },
      { name: 'Base', kind: 'class', fields: [field('id', { type: primitive('integer') }), field('name')] },
      {
        name: 'User',
        kind: 'class',
        extends: ['Base'],
        fields: [field('name', { nullable: true }), field('address', { type: { kind: 'model', name: 'Address' } })],
      },
    ],
  }

  it('includes inherited fields, the child winning', () => {
    const user = schema.models[2]
    expect(allFields(schema, user).map((item) => [item.name, item.nullable])).toEqual([
      ['id', false],
      ['name', true],
      ['address', false],
    ])
  })

  it('picks as root a model no other model refers to', () => {
    expect(defaultRoot(schema)).toBe('Base')
    expect(defaultRoot({ ...schema, root: 'User' })).toBe('User')
  })

  it('knows which fields need a value', () => {
    expect(needsValue(field('a'))).toBe(true)
    expect(needsValue(field('a', { optional: true }))).toBe(false)
    expect(needsValue(field('a', { defaultValue: '' }))).toBe(false)
    expect(needsValue(field('a', { generated: true }))).toBe(false)
  })

  it('describes types', () => {
    expect(describeType({ kind: 'array', items: primitive('integer', 32), itemsNullable: true })).toBe('(integer32 | null)[]')
    expect(describeType({ kind: 'map', key: primitive('string'), value: { kind: 'model', name: 'A' } })).toBe('map<string, A>')
  })
})
