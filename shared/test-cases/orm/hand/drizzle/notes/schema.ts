import { sql } from 'drizzle-orm'
import { blob, customType, index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

const money = customType<{ data: string }>({
  dataType() {
    return 'decimal(10, 2)'
  },
})

export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title', { length: 80 }).notNull(),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    meta: text('meta', { mode: 'json' }),
    picture: blob('picture'),
    weight: real('weight'),
    cost: money('cost'),
    folderId: integer('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
  },
  (t) => [index('notes_folder_idx').on(t.folderId), unique().on(t.title, t.folderId)],
)

export const folders = sqliteTable('folders', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})
