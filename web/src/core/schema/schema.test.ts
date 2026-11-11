import { describe, expect, it } from 'vitest'
import { findTable, isUniqueKey, type DbSchema, type DbTable } from './types.ts'
import { validateDbSchema } from './validate.ts'

const integer = { sql: 'integer', kind: 'integer', bits: 32 } as const
const text = (length?: number) => ({ sql: length ? `varchar(${length})` : 'text', kind: 'text', ...(length ? { length } : {}) }) as const

function table(name: string, extra: Partial<DbTable> = {}): DbTable {
  return {
    name,
    columns: [{ name: 'id', type: integer, nullable: false, generated: 'identity' }],
    primaryKey: ['id'],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    ...extra,
  }
}

function schema(tables: DbTable[], enums: DbSchema['enums'] = []): DbSchema {
  return { format: 'db-schema', version: 1, dialect: 'postgresql', source: { kind: 'ddl', format: 'postgresql' }, tables, enums, notes: [] }
}

const customers = table('customers', {
  columns: [
    { name: 'id', type: integer, nullable: false, generated: 'identity' },
    { name: 'email', type: text(120), nullable: false },
  ],
  uniques: [{ name: 'uq_customers_email', columns: ['email'] }],
})

describe('db-schema helpers', () => {
  it('finds tables by name and namespace', () => {
    const sales = { ...table('orders'), schema: 'sales' }
    const value = schema([table('orders'), sales])
    expect(findTable(value, 'orders')).toBe(value.tables[0])
    expect(findTable(value, 'orders', 'sales')).toBe(sales)
  })

  it('knows the keys of a table, in any column order', () => {
    const lines = table('order_lines', {
      columns: [
        { name: 'order_id', type: integer, nullable: false },
        { name: 'line', type: integer, nullable: false },
      ],
      primaryKey: ['order_id', 'line'],
    })
    expect(isUniqueKey(lines, ['line', 'order_id'])).toBe(true)
    expect(isUniqueKey(lines, ['line'])).toBe(false)
    expect(isUniqueKey(customers, ['email'])).toBe(true)
  })
})

describe('validateDbSchema', () => {
  it('accepts a consistent schema', () => {
    const orders = table('orders', {
      columns: [
        { name: 'id', type: integer, nullable: false },
        { name: 'customer_id', type: integer, nullable: false },
        { name: 'status', type: { sql: 'order_status', kind: 'enum', name: 'order_status' }, nullable: false },
      ],
      foreignKeys: [{ name: 'fk_orders_customer', columns: ['customer_id'], references: { table: 'customers', columns: ['id'] } }],
      indexes: [{ columns: ['status'] }],
      checks: [{ sql: "status IN ('new', 'paid')", parsed: { kind: 'in', column: 'status', values: ['new', 'paid'] } }],
    })
    const enums = [{ name: 'order_status', values: ['new', 'paid'], storage: 'native' as const }]
    expect(validateDbSchema(schema([customers, orders], enums))).toEqual([])
  })

  it('reports repeated names and tables without columns', () => {
    const issues = validateDbSchema(
      schema([
        table('items', {
          columns: [
            { name: 'id', type: integer, nullable: false },
            { name: 'id', type: integer, nullable: false },
          ],
        }),
        table('items'),
        table('empty', { columns: [], primaryKey: null }),
      ]),
    )
    expect(issues.map((issue) => [issue.code, issue.table])).toEqual([
      ['duplicateColumn', 'items'],
      ['duplicateTable', 'items'],
      ['noColumns', 'empty'],
    ])
  })

  it('reports keys, indexes and checks on missing columns', () => {
    const issues = validateDbSchema(
      schema([
        table('items', {
          primaryKey: ['code'],
          uniques: [{ name: 'uq_sku', columns: ['sku'] }],
          indexes: [{ columns: ['name'] }],
          checks: [{ sql: 'price > 0', parsed: { kind: 'compare', column: 'price', op: '>', value: 0 } }],
        }),
      ]),
    )
    expect(issues.map((issue) => issue.params)).toEqual([
      { column: 'code', place: 'primaryKey', constraint: '' },
      { column: 'sku', place: 'unique', constraint: 'uq_sku' },
      { column: 'name', place: 'index', constraint: '' },
      { column: 'price', place: 'check', constraint: '' },
    ])
  })

  it('reports foreign keys to missing tables or columns, and with the wrong number of columns', () => {
    const issues = validateDbSchema(
      schema([
        customers,
        table('orders', {
          foreignKeys: [
            { columns: ['id'], references: { table: 'clients', columns: ['id'] } },
            { columns: ['id'], references: { table: 'customers', columns: ['id', 'email'] } },
            { columns: ['id'], references: { table: 'customers', columns: ['code'] } },
          ],
        }),
      ]),
    )
    expect(issues.map((issue) => [issue.code, issue.params.target])).toEqual([
      ['unknownTable', 'clients'],
      ['foreignKeyArity', 'customers'],
      ['unknownColumn', 'customers'],
    ])
  })

  it('warns when a foreign key points to columns that are not a key', () => {
    const issues = validateDbSchema(
      schema([
        table('customers', { columns: [...customers.columns, { name: 'city', type: text(), nullable: true }] }),
        table('stores', {
          columns: [
            { name: 'id', type: integer, nullable: false },
            { name: 'city', type: text(), nullable: true },
          ],
          foreignKeys: [{ columns: ['city'], references: { table: 'customers', columns: ['city'] } }],
        }),
      ]),
    )
    expect(issues).toEqual([
      {
        code: 'foreignKeyNotUnique',
        severity: 'warning',
        table: 'stores',
        params: { target: 'customers', columns: 'city', constraint: '' },
      },
    ])
  })

  it('reports enums that are not declared, also inside arrays', () => {
    const issues = validateDbSchema(
      schema([
        table('posts', {
          columns: [
            { name: 'id', type: integer, nullable: false },
            { name: 'tags', type: { sql: 'tag[]', kind: 'array', items: { sql: 'tag', kind: 'enum', name: 'tag' } }, nullable: true },
          ],
        }),
      ]),
    )
    expect(issues.map((issue) => [issue.code, issue.params.enum])).toEqual([['unknownEnum', 'tag']])
  })
})
