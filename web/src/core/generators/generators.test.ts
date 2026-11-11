import { describe, expect, it } from 'vitest'
import { decidePolicy } from '../crud/edit.ts'
import { SHOP } from '../crud/fixtures.ts'
import { proposeCrud } from '../crud/propose.ts'
import { DEFAULT_SETTINGS, normalizeSettings, STACKS, type ProjectSettings } from '../settings/settings.ts'
import { isVerified, VERIFIED } from '../settings/verified.ts'
import { generateProject } from './registry.ts'

const design = proposeCrud(SHOP)
const generate = (settings: Partial<ProjectSettings> = {}) => generateProject(SHOP, design, settings)
const paths = (settings: Partial<ProjectSettings> = {}) => generate(settings).map((file) => file.path)
const file = (path: string, settings: Partial<ProjectSettings> = {}) => generate(settings).find((item) => item.path === path)?.content ?? ''

describe('normalizeSettings', () => {
  it('fills what is missing with the defaults', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('drops options the stack does not offer, and values that do not exist', () => {
    const settings = normalizeSettings({ database: 'oracle', errors: 'results', paging: 'pages' as never, entitiesModule: '1bad' })
    expect(settings).toMatchObject({ database: 'postgresql', errors: 'exceptions', paging: 'offset', entitiesModule: 'app.entities' })
  })

  it('writes the name as lowercase words', () => {
    expect(normalizeSettings({ name: 'Tienda Online!' }).name).toBe('tienda-online')
    expect(normalizeSettings({ name: '' }).name).toBe(DEFAULT_SETTINGS.name)
  })

  it('has no service tests without services', () => {
    expect(normalizeSettings({ services: false, tests: 'all' }).tests).toBe('repositories')
    expect(normalizeSettings({ services: false, tests: 'services' }).tests).toBe('none')
  })
})

describe('verified stacks', () => {
  it('are stacks a generator writes, with options it offers', () => {
    for (const item of VERIFIED) {
      const stack = STACKS.find((candidate) => candidate.language === item.language && candidate.orm === item.orm)
      expect(stack?.databases).toContain(item.database)
      expect(stack?.execution).toContain(item.execution)
    }
    expect(isVerified({ language: 'python', orm: 'sqlalchemy', database: 'postgresql', execution: 'async' })).toBe(true)
  })
})

describe('the SQLAlchemy generator', () => {
  it('writes a project by layer', () => {
    expect(paths()).toEqual(
      expect.arrayContaining([
        'README.md',
        'pyproject.toml',
        'requirements.txt',
        'crud-contract.json',
        'app/db.py',
        'app/errors.py',
        'app/paging.py',
        'app/unit_of_work.py',
        'app/entities/customer.py',
        'app/repositories/customer.py',
        'app/services/customer.py',
        'tests/conftest.py',
        'tests/factories.py',
        'tests/test_customer.py',
      ]),
    )
    // Join tables have a repository and no service
    expect(paths()).toContain('app/repositories/product_tag.py')
    expect(paths()).not.toContain('app/services/product_tag.py')
  })

  it('writes one folder per table', () => {
    expect(paths({ architecture: 'table' })).toEqual(
      expect.arrayContaining(['app/customer/entity.py', 'app/customer/repository.py', 'app/customer/service.py']),
    )
  })

  it('writes asynchronous code when asked', () => {
    expect(file('app/repositories/customer.py', { execution: 'async' })).toContain(
      'async def find_by_email(self, email: str) -> Customer | None:',
    )
    expect(file('app/db.py', { execution: 'async' })).toContain('create_async_engine')
    expect(file('requirements.txt', { execution: 'async', database: 'mysql' })).toContain('aiomysql')
  })

  it('writes DTOs, as Pydantic models or dataclasses', () => {
    expect(file('app/dtos/customer.py', { serviceTypes: 'dtos' })).toContain('class CustomerCreate(BaseModel):')
    expect(file('app/dtos/customer.py', { serviceTypes: 'dtos', dtoKind: 'dataclass' })).toContain('@dataclass(kw_only=True)')
    // Hidden columns are not returned
    expect(file('app/dtos/customer.py', { serviceTypes: 'dtos' }).split('class CustomerRead')[1]).not.toContain('password_hash')
  })

  it('places transactions where the settings say', () => {
    expect(file('app/services/customer.py')).toContain('with self._uow.transaction():')
    expect(file('app/services/customer.py', { transactions: 'caller' })).not.toContain('transaction()')
    expect(file('app/repositories/customer.py', { transactions: 'repository' })).toContain('self._session.commit()')
  })

  it('names reads with the chosen verbs', () => {
    expect(file('app/services/customer.py')).toContain('def get_customer(')
    expect(file('app/services/customer.py')).toContain('def find_customer_by_email(')
    expect(file('app/services/customer.py', { verbs: 'find' })).toContain('def find_customer(')
    expect(file('app/repositories/customer.py', { verbs: 'get' })).toContain('def get_by_email(')
  })

  it('leaves out what the settings turn off', () => {
    expect(file('app/repositories/customer.py', { repositoryInterfaces: false })).not.toContain('Protocol')
    expect(file('app/repositories/customer.py', { memoryRepositories: false })).not.toContain('MemoryCustomerRepository')
    expect(paths({ services: false }).some((path) => path.startsWith('app/services/'))).toBe(false)
    expect(paths({ tests: 'none' }).some((path) => path.startsWith('tests/'))).toBe(false)
    expect(paths({ paging: 'none' })).not.toContain('app/paging.py')
  })

  it('follows the decisions of the review', () => {
    expect(file('app/services/product.py')).toContain('current.deleted_at = datetime.now(UTC)')
    const hard = proposeCrud(SHOP, decidePolicy(design, 'products', 'delete', { mode: 'hard' }))
    expect(generateProject(SHOP, hard, {}).find((item) => item.path === 'app/services/product.py')!.content).toContain(
      'self._uow.products.delete(current)',
    )
  })

  it('never writes a value it could not compute', () => {
    const variants: Partial<ProjectSettings>[] = [
      {},
      { execution: 'async', serviceTypes: 'dtos', dtoKind: 'dataclass', paging: 'cursor', architecture: 'table' },
      { transactions: 'repository', repositoryInterfaces: false, memoryRepositories: false, verbs: 'get' },
    ]
    for (const settings of variants)
      for (const item of generate(settings)) expect(item.content, item.path).not.toMatch(/undefined|\[object Object\]|NaN/)
  })

  it('describes what it wrote in crud-contract.json', () => {
    const contract = JSON.parse(file('crud-contract.json'))
    expect(contract).toMatchObject({ format: 'crud-contract', version: 1, stack: { language: 'python', orm: 'sqlalchemy' } })
    const customers = contract.services.find((service: { name: string }) => service.name === 'CustomerService')
    expect(customers.operations[0]).toEqual({ name: 'create_customer', kind: 'create', errors: ['validation', 'conflict'] })
  })
})
