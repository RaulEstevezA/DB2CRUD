import { describe, expect, it } from 'vitest'
import { validateDbSchema } from '../schema/validate.ts'
import { SHOP } from './fixtures.ts'
import { entityName, proposeCrud } from './propose.ts'
import { findPolicy, findRepository, findService, type CrudDesign } from './types.ts'

const design = proposeCrud(SHOP)
const policy = (table: string) => findPolicy(design, table)!
const queries = (table: string) => findRepository(design, table)!.queries.map((query) => query.name)
const operations = (table: string) => findService(design, table)?.operations.map((operation) => operation.name)

describe('the shop fixture', () => {
  it('is a consistent schema', () => {
    expect(validateDbSchema(SHOP)).toEqual([])
  })
})

describe('entity names', () => {
  it('come from the singular of the table name, or the class of the input', () => {
    expect(entityName(SHOP.tables[4])).toBe('OrderLine')
    expect(entityName(SHOP.tables[1])).toBe('Category')
    expect(entityName({ ...SHOP.tables[0], entity: 'Client' })).toBe('Client')
  })
})

describe('table decisions', () => {
  it('gives every table a role', () => {
    expect(design.policies.map((item) => [item.table, item.role.value, item.role.confidence])).toEqual([
      ['customers', 'entity', 'exact'],
      ['categories', 'entity', 'exact'],
      ['products', 'entity', 'exact'],
      ['orders', 'entity', 'exact'],
      ['order_lines', 'entity', 'exact'],
      ['tags', 'entity', 'exact'],
      ['product_tags', 'join', 'probable'],
      ['audit_log', 'readOnly', 'review'],
    ])
  })

  it('proposes soft deletes and versions from their columns, and waits for the user on soft deletes', () => {
    expect(policy('products').delete).toMatchObject({ value: { mode: 'soft', column: 'deleted_at' }, status: 'pending' })
    expect(policy('products').concurrency).toMatchObject({ value: { mode: 'version', column: 'version' }, status: 'active' })
    expect(policy('orders').delete).toMatchObject({ value: { mode: 'hard' }, confidence: 'exact' })
  })

  it('asks what to do with children the database does not delete', () => {
    expect(policy('categories').children).toMatchObject({
      value: 'block',
      status: 'pending',
      reasons: [{ params: { tables: 'products' } }],
    })
    expect(policy('products').children?.reasons[0].params).toEqual({ tables: 'order_lines' })
    // Order lines go with their order (ON DELETE CASCADE)
    expect(policy('orders').children).toBeNull()
  })

  it('hides columns named like secrets, pending review', () => {
    expect(policy('customers').hidden).toMatchObject({ value: ['password_hash'], status: 'pending' })
    expect(policy('orders').hidden.value).toEqual([])
  })
})

describe('repositories', () => {
  it('deduces the queries from keys, unique constraints, foreign keys and indexes', () => {
    expect(queries('customers')).toEqual(['getById', 'list', 'findByEmail', 'insert', 'update', 'delete'])
    expect(queries('products')).toEqual(['getById', 'list', 'listByCategoryId', 'findAllByStatus', 'insert', 'update', 'delete'])
    expect(queries('order_lines')).toEqual([
      'getByOrderIdAndLine',
      'list',
      'listByOrderId',
      'listByProductId',
      'insert',
      'update',
      'delete',
    ])
  })

  it('keeps a query from a plain index pending, since the index may exist only for speed', () => {
    const byStatus = findRepository(design, 'products')!.queries.find((query) => query.name === 'findAllByStatus')!
    expect(byStatus.include).toMatchObject({ value: true, status: 'pending', confidence: 'review' })
  })

  it('only reads tables without a primary key, and only inserts and deletes links', () => {
    expect(queries('audit_log')).toEqual(['list'])
    expect(queries('product_tags')).toEqual(['getByProductIdAndTagId', 'list', 'listByProductId', 'listByTagId', 'insert', 'delete'])
  })

  it('knows which entities the input lacks', () => {
    expect(findRepository(design, 'customers')!.entityMissing).toBe(true)
  })
})

describe('services', () => {
  it('proposes the operations of each table, and none for join tables', () => {
    expect(operations('customers')).toEqual([
      'createCustomer',
      'getCustomer',
      'listCustomers',
      'updateCustomer',
      'deleteCustomer',
      'findCustomerByEmail',
    ])
    expect(operations('product_tags')).toBeUndefined()
    expect(operations('audit_log')).toEqual(['listAuditLogs'])
  })

  it('links and unlinks through join tables, from both sides', () => {
    expect(operations('products')).toContain('addTag')
    expect(operations('tags')).toEqual(expect.arrayContaining(['addProduct', 'removeProduct']))
  })

  it('checks what the schema requires before writing, and says which errors each operation raises', () => {
    const service = findService(design, 'products')!
    const find = (id: string) => service.operations.find((operation) => operation.id === id)!
    expect(find('create')).toMatchObject({ checks: ['validate', 'parentExists'], errors: ['ValidationFailed'] })
    expect(find('update')).toMatchObject({
      checks: ['validate', 'parentExists', 'version'],
      errors: ['NotFound', 'ValidationFailed', 'Conflict'],
    })
    expect(find('delete')).toMatchObject({ checks: ['version', 'children'], errors: ['NotFound', 'Conflict'] })
    expect(findService(design, 'customers')!.operations[0]).toMatchObject({
      checks: ['validate', 'unique'],
      errors: ['ValidationFailed', 'Conflict'],
    })
  })
})

describe('keeping the review', () => {
  function choose(previous: CrudDesign, table: string, change: (policy: CrudDesign['policies'][number]) => void): CrudDesign {
    const copy: CrudDesign = JSON.parse(JSON.stringify(previous))
    change(copy.policies.find((item) => item.table === table)!)
    return copy
  }

  it('keeps the user’s choices when the schema is proposed again', () => {
    const edited = choose(design, 'categories', (item) => {
      item.children = { ...item.children!, value: 'deleteFirst', status: 'active', manual: true }
    })
    const again = proposeCrud(SHOP, edited)
    expect(findPolicy(again, 'categories')!.children).toMatchObject({ value: 'deleteFirst', manual: true })
    const remove = findService(again, 'categories')!.operations.find((operation) => operation.id === 'delete')!
    expect(remove).toMatchObject({ checks: [], errors: ['NotFound'] })
  })

  it('drops a choice that no longer applies', () => {
    const edited = choose(design, 'products', (item) => {
      item.delete = { ...item.delete, status: 'active', manual: true }
    })
    const without = {
      ...SHOP,
      tables: SHOP.tables.map((table) =>
        table.name === 'products' ? { ...table, columns: table.columns.filter((c) => c.name !== 'deleted_at') } : table,
      ),
    }
    expect(findPolicy(proposeCrud(without, edited), 'products')!.delete).toMatchObject({ value: { mode: 'hard' }, confidence: 'exact' })
    expect(findPolicy(proposeCrud(without, edited), 'products')!.delete.manual).toBeUndefined()
  })

  it('treats a join table the user makes an entity as an ordinary table', () => {
    const edited = choose(design, 'product_tags', (item) => {
      item.role = { ...item.role, value: 'entity', status: 'active', manual: true }
    })
    const again = proposeCrud(SHOP, edited)
    expect(findService(again, 'product_tags')!.name).toBe('ProductTagService')
    expect(findService(again, 'products')!.operations.map((operation) => operation.name)).not.toContain('addTag')
  })
})
