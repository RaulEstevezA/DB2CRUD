// Drizzle schema written by Model2DB from Item. Review it, then run `npx drizzle-kit generate`.
import { relations } from 'drizzle-orm'
import { type AnyMySqlColumn, bigint, decimal, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core'

export const categories = mysqlTable('categories', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  parentId: bigint('parent_id', { mode: 'number' }).notNull().references((): AnyMySqlColumn => categories.id),
}, (table) => [
  index('ix_categories_parent_id').on(table.parentId),
])

export const items = mysqlTable('items', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  price: decimal('price', { precision: 18, scale: 2 }).notNull(),
  supplierEmail: varchar('supplier_email', { length: 255 }).notNull(),
  stock: int('stock').notNull(),
  categoryId: bigint('category_id', { mode: 'number' }).notNull().references((): AnyMySqlColumn => categories.id),
}, (table) => [
  index('ix_items_category_id').on(table.categoryId),
])

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id], relationName: 'Category_parent' }),
}))

export const itemsRelations = relations(items, ({ one, many }) => ({
  category: one(categories, { fields: [items.categoryId], references: [categories.id], relationName: 'Item_category' }),
}))
