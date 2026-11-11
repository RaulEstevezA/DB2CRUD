/**
 * Tests of the compatibility matrix and of the normalization of settings.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, FRAMEWORKS, databasesFor, normalizeSettings, slug } from './stack.ts'

describe('normalizeSettings', () => {
  it('keeps settings the framework supports', () => {
    const settings = { ...DEFAULT_SETTINGS, persistence: 'sqlalchemy' as const, database: 'mysql' as const, auth: 'jwt' as const }
    expect(normalizeSettings(settings)).toEqual(settings)
  })

  it('moves options the new framework does not offer to its first one', () => {
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, framework: 'djangoRest', persistence: 'memory', database: null })
    expect(settings).toMatchObject({ persistence: 'djangoOrm', database: 'postgresql' })
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, framework: 'nestjs', architecture: 'layered' }).architecture).toBe('modular')
  })

  it('drops the database of a persistence that needs none, and keeps a valid one', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, persistence: 'memory', database: 'mysql' }).database).toBeNull()
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, framework: 'springBoot', persistence: 'jpa', database: 'sqlite' }).database).toBe(
      'postgresql',
    )
  })

  it('cleans the project name and the Java package', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, name: ' My Shop API!' }).name).toBe('my-shop-api')
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, name: '***' }).name).toBe('api')
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, javaPackage: 'Com.Example' }).javaPackage).toBe('com.example.api')
  })
})

describe('matrix', () => {
  it('offers at least one architecture, persistence and authentication per framework', () => {
    for (const framework of FRAMEWORKS) {
      expect(framework.architectures.length, framework.id).toBeGreaterThan(0)
      expect(framework.persistence.length, framework.id).toBeGreaterThan(0)
      expect(framework.auth, framework.id).toContain('none')
    }
  })

  it('lists the databases of each persistence', () => {
    expect(databasesFor('fastapi', 'sqlalchemy')).toEqual(['postgresql', 'mysql', 'mariadb', 'sqlite'])
    expect(databasesFor('fastapi', 'memory')).toEqual([])
  })

  it('writes names as slugs', () => {
    expect(slug('ShopApi')).toBe('shop-api')
    expect(slug('pet store')).toBe('pet-store')
  })
})
