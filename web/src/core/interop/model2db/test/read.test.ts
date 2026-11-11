import { describe, expect, it } from 'vitest'
import { proposeCrud } from '../../../crud/propose.ts'
import { findTable } from '../../../schema/types.ts'
import { validateDbSchema } from '../../../schema/validate.ts'
import { readModel2DBProject } from '../read.ts'
import { shopProject } from './fixtures.ts'

function read(output: string, engine?: Parameters<typeof shopProject>[1], text?: string) {
  const result = readModel2DBProject(shopProject(output, engine, text))
  if (!result.ok) throw new Error(`not read: ${result.error}`)
  return result.schema
}

describe('readModel2DBProject', () => {
  it('builds the tables Model2DB builds for the project', () => {
    const schema = read('postgresql')
    expect(schema).toMatchObject({
      format: 'db-schema',
      version: 1,
      dialect: 'postgresql',
      source: { kind: 'model2db', format: 'postgresql' },
    })
    expect(schema.tables.map((table) => table.name)).toEqual(['customers', 'orders', 'order_lines'])
    expect(validateDbSchema(schema)).toEqual([])
  })

  it('keeps the types as Model2DB writes them for the engine', () => {
    const orders = findTable(read('postgresql'), 'orders')!
    expect(orders.columns.map((column) => [column.name, column.type.sql, column.type.kind])).toEqual([
      ['id', 'BIGINT', 'integer'],
      ['status', 'VARCHAR(20)', 'text'],
      ['total', 'DOUBLE PRECISION', 'float'],
      ['placed_at', 'TIMESTAMPTZ', 'datetime'],
      ['customer_id', 'BIGINT', 'integer'],
    ])
    expect(findTable(read('mysql'), 'orders')!.columns[3].type).toMatchObject({ kind: 'datetime', timezone: false })
  })

  it('keeps keys, foreign keys with their navigation names, indexes and enum checks', () => {
    const orders = findTable(read('postgresql'), 'orders')!
    expect(orders.primaryKey).toEqual(['id'])
    expect(orders.foreignKeys).toEqual([
      {
        name: 'fk_orders_customer_id',
        columns: ['customer_id'],
        references: { table: 'customers', columns: ['id'] },
        attribute: 'customer',
        inverse: 'orders',
      },
    ])
    expect(orders.indexes).toEqual([{ name: 'ix_orders_customer_id', columns: ['customer_id'] }])
    expect(orders.checks).toEqual([
      {
        name: 'ck_orders_status',
        sql: "status IN ('new', 'paid', 'sent')",
        parsed: { kind: 'in', column: 'status', values: ['new', 'paid', 'sent'] },
      },
    ])
  })

  it('uses the engine of an ORM output, or its first one when it does not support the project’s', () => {
    expect(read('sqlalchemy', 'mysql')).toMatchObject({ dialect: 'mysql', source: { format: 'sqlalchemy' } })
    expect(read('prisma', 'oracle').dialect).toBe('postgresql')
  })

  it('names the entities when the output writes classes, and not when it writes SQL', () => {
    expect(read('sqlalchemy').tables.map((table) => table.entity)).toEqual(['Customer', 'Order', 'OrderLine'])
    expect(read('flyway').tables.every((table) => table.entity === undefined)).toBe(true)
  })

  it('gives a schema the CRUD design can be proposed from', () => {
    const design = proposeCrud(read('postgresql'))
    expect(design.services.map((service) => service.name)).toEqual(['CustomerService', 'OrderService', 'OrderLineService'])
  })

  it('says why a project cannot be read', () => {
    expect(readModel2DBProject('not json')).toEqual({ ok: false, error: 'notJson' })
    expect(readModel2DBProject('{"format": "mapper-project"}')).toEqual({ ok: false, error: 'notProject' })
    expect(readModel2DBProject(shopProject('mongodb'))).toEqual({ ok: false, error: 'notRelational' })
    expect(readModel2DBProject(shopProject('postgresql', 'postgresql', 'export const x = 1'))).toEqual({ ok: false, error: 'noModels' })
    const damaged = JSON.parse(shopProject('postgresql'))
    damaged.output.strings = 42
    damaged.input.text = 42
    expect(readModel2DBProject(JSON.stringify(damaged))).toMatchObject({ ok: false, error: 'invalid', path: '$.input' })
  })
})
