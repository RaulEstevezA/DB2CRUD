/**
 * An invented shop database used by the tests of the CRUD design: every case the rules know, in one schema.
 */
import type { DbColumn, DbSchema, DbTable, DbType } from '../schema/types.ts'

const integer: DbType = { sql: 'integer', kind: 'integer', bits: 32 }
const bigint: DbType = { sql: 'bigint', kind: 'integer', bits: 64 }
const text = (length?: number): DbType => (length ? { sql: `varchar(${length})`, kind: 'text', length } : { sql: 'text', kind: 'text' })
const money: DbType = { sql: 'numeric(10,2)', kind: 'decimal', precision: 10, scale: 2 }
const timestamp: DbType = { sql: 'timestamptz', kind: 'datetime', timezone: true }

const column = (name: string, type: DbType, extra: Partial<DbColumn> = {}): DbColumn => ({ name, type, nullable: false, ...extra })
const id = column('id', bigint, { generated: 'identity' })

function table(name: string, columns: DbColumn[], extra: Partial<DbTable> = {}): DbTable {
  return { name, columns, primaryKey: ['id'], foreignKeys: [], uniques: [], indexes: [], checks: [], ...extra }
}

export const SHOP: DbSchema = {
  format: 'db-schema',
  version: 1,
  dialect: 'postgresql',
  source: { kind: 'ddl', format: 'postgresql' },
  tables: [
    table(
      'customers',
      [id, column('email', text(120)), column('password_hash', text(), {}), column('created_at', timestamp, { generated: 'now' })],
      {
        uniques: [{ name: 'uq_customers_email', columns: ['email'] }],
      },
    ),
    table('categories', [id, column('name', text(60))], { uniques: [{ columns: ['name'] }] }),
    table(
      'products',
      [
        id,
        column('category_id', bigint),
        column('name', text(100)),
        column('price', money),
        column('status', text(10)),
        column('version', integer, { default: { kind: 'literal', value: 1 } }),
        column('deleted_at', timestamp, { nullable: true }),
      ],
      {
        foreignKeys: [{ name: 'fk_products_category', columns: ['category_id'], references: { table: 'categories', columns: ['id'] } }],
        indexes: [{ name: 'ix_products_status', columns: ['status'] }, { columns: ['category_id'] }],
        checks: [{ sql: 'price >= 0', parsed: { kind: 'compare', column: 'price', op: '>=', value: 0 } }],
      },
    ),
    table('orders', [id, column('customer_id', bigint), column('placed_at', timestamp, { generated: 'now' })], {
      foreignKeys: [{ columns: ['customer_id'], references: { table: 'customers', columns: ['id'] } }],
    }),
    table('order_lines', [column('order_id', bigint), column('line', integer), column('product_id', bigint), column('quantity', integer)], {
      primaryKey: ['order_id', 'line'],
      foreignKeys: [
        { columns: ['order_id'], references: { table: 'orders', columns: ['id'] }, onDelete: 'cascade' },
        { columns: ['product_id'], references: { table: 'products', columns: ['id'] }, onDelete: 'restrict' },
      ],
    }),
    table('tags', [id, column('label', text(30))]),
    table('product_tags', [column('product_id', bigint), column('tag_id', bigint)], {
      primaryKey: ['product_id', 'tag_id'],
      foreignKeys: [
        { columns: ['product_id'], references: { table: 'products', columns: ['id'] }, onDelete: 'cascade' },
        { columns: ['tag_id'], references: { table: 'tags', columns: ['id'] }, onDelete: 'cascade' },
      ],
    }),
    table('audit_log', [column('at', timestamp), column('message', text())], { primaryKey: null }),
  ],
  enums: [],
  notes: [],
}
