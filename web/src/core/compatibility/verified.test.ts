/**
 * Tests of how far a stack is verified.
 */
import { describe, expect, it } from 'vitest'
import { FRAMEWORKS, databasesFor } from './stack.ts'
import { VERIFIED, verification } from './verified.ts'

describe('verification', () => {
  it('tells exact stacks, stacks verified by parts and unverified ones', () => {
    expect(verification({ framework: 'fastapi', architecture: 'layered', persistence: 'memory', database: null, auth: 'none' })).toBe(
      'verified',
    )
    expect(
      verification({ framework: 'fastapi', architecture: 'modular', persistence: 'sqlalchemy', database: 'postgresql', auth: 'apiKey' }),
    ).toBe('parts')
    expect(verification({ framework: 'nestjs', architecture: 'modular', persistence: 'memory', database: null, auth: 'none' })).toBe(
      'verified',
    )
    // No scenario has run FastAPI on MongoDB
    expect(
      verification({ framework: 'fastapi', architecture: 'layered', persistence: 'sqlalchemy', database: 'mongodb', auth: 'none' }),
    ).toBe('unverified')
  })

  it('only lists stacks the matrix offers', () => {
    for (const item of VERIFIED) {
      const framework = FRAMEWORKS.find((candidate) => candidate.id === item.framework)!
      expect(framework.architectures).toContain(item.architecture)
      expect(framework.auth).toContain(item.auth)
      const databases = databasesFor(item.framework, item.persistence)
      expect(item.database === null ? databases.length === 0 : databases.includes(item.database), JSON.stringify(item)).toBe(true)
    }
  })
})
