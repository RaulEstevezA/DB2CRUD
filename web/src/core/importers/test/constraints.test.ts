/**
 * Tests of the validation facts the importers keep for Model2API: JSON Schema keywords in metadata and
 * Zod checks as annotations.
 */
import { describe, expect, it } from 'vitest'
import { findModel } from '../../model/schema.ts'
import { parseOk } from './helpers.ts'

describe('JSON Schema constraints', () => {
  it('keeps the validation keywords of each property', () => {
    const { schema } = parseOk(
      JSON.stringify({
        title: 'Pet',
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z]+$' },
          email: { type: 'string', format: 'email' },
          age: { type: 'integer', minimum: 0, exclusiveMaximum: 50 },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 5, uniqueItems: true },
          note: { type: 'string' },
        },
      }),
      'jsonschema',
    )
    const fields = findModel(schema, 'Pet')!.fields
    const metadata = Object.fromEntries(fields.map((field) => [field.name, field.metadata]))
    expect(metadata.name).toEqual({ minLength: 1, maxLength: 40, pattern: '^[a-z]+$' })
    expect(metadata.email).toEqual({ format: 'email' })
    expect(metadata.age).toEqual({ minimum: 0, exclusiveMaximum: 50 })
    expect(metadata.tags).toEqual({ maxItems: 5, uniqueItems: true })
    expect(metadata.note).toBeUndefined()
  })

  it('keeps them in OpenAPI schemas too', () => {
    const { schema } = parseOk(
      'openapi: 3.0.3\ninfo: {title: Shop, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Product:\n      type: object\n      properties:\n        price: {type: number, minimum: 0}\n',
      'openapi',
    )
    expect(findModel(schema, 'Product')!.fields[0].metadata).toEqual({ minimum: 0 })
  })
})

describe('Zod checks', () => {
  it('keeps checks as annotations, with their arguments', () => {
    const { schema } = parseOk(
      "import { z } from 'zod'\nexport const User = z.object({ email: z.string().email(), name: z.string().min(2).max(40), id: z.uuid(), age: z.number().int().optional() })",
      'typescript',
    )
    const fields = Object.fromEntries(findModel(schema, 'User')!.fields.map((field) => [field.name, field.annotations]))
    expect(fields.email).toEqual([{ name: 'z.email', args: '' }])
    expect(fields.name).toEqual([
      { name: 'z.min', args: '2' },
      { name: 'z.max', args: '40' },
    ])
    expect(fields.id).toEqual([{ name: 'z.uuid', args: '' }])
    expect(fields.age).toBeUndefined()
  })

  it('does not apply checks written before .array() to the list', () => {
    const { schema } = parseOk("import { z } from 'zod'\nexport const Post = z.object({ tags: z.string().min(1).array() })", 'typescript')
    expect(findModel(schema, 'Post')!.fields[0].annotations).toBeUndefined()
  })
})
