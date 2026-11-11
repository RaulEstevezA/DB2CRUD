/**
 * Tests of the facts collected about each model.
 */
import { describe, expect, it } from 'vitest'
import { parseInput } from '../importers/registry.ts'
import { analyzeModels, auditKind, isSecretName } from './models.ts'

describe('analyzeModels', () => {
  it('finds declared entities, declared keys and who refers to each model', () => {
    const outcome = parseInput(
      `@Entity public class Author { @Id @GeneratedValue private Long id; private String name; }
public class Book { private String isbn; private Author author; private List<Author> coAuthors; }`,
      'java',
    )
    if (!outcome.ok) throw new Error('parse')
    const facts = analyzeModels(outcome.schema)
    expect(facts.get('Author')).toMatchObject({ declaredEntity: true, declaredKey: 'id', declaredKeyGenerated: true, namedKey: 'id' })
    expect(facts.get('Author')!.referencedBy).toEqual([
      { model: 'Book', field: 'author', many: false },
      { model: 'Book', field: 'coAuthors', many: true },
    ])
    expect(facts.get('Book')).toMatchObject({ declaredEntity: false, declaredKey: null, namedKey: null, keyCandidates: ['isbn'] })
  })

  it('takes the model name followed by Id as a named key', () => {
    const outcome = parseInput('export interface Invoice { invoiceId: number; total: number }', 'typescript')
    if (!outcome.ok) throw new Error('parse')
    expect(analyzeModels(outcome.schema).get('Invoice')!.namedKey).toBe('invoiceId')
  })
})

describe('names', () => {
  it('recognizes secrets by whole words', () => {
    for (const name of ['password', 'passwordHash', 'api_key', 'apiKey', 'refreshToken', 'PIN', 'clientSecret'])
      expect(isSecretName(name), name).toBe(true)
    for (const name of ['spin', 'shipping', 'tokens', 'keyboard', 'name']) expect(isSecretName(name), name).toBe(false)
  })

  it('recognizes timestamps the server keeps', () => {
    expect(auditKind('createdAt')).toBe('created')
    expect(auditKind('created_at')).toBe('created')
    expect(auditKind('updatedOn')).toBe('updated')
    expect(auditKind('lastModified')).toBe('updated')
    expect(auditKind('birthDate')).toBeNull()
  })
})
