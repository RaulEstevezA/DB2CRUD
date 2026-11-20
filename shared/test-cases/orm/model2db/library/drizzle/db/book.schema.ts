// Drizzle schema written by Model2DB from Book. Review it, then run `npx drizzle-kit generate`.
import { relations, sql } from 'drizzle-orm'
import { type AnyPgColumn, boolean, check, date, index, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core'

export const authors = pgTable('authors', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  email: text('email'),
  born: date('born'),
})

// TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
export const books = pgTable('books', {
  id: uuid('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  isbn: text('isbn').notNull(),
  genre: varchar('genre', { length: 20 }).notNull(),
  pages: integer('pages').notNull(),
  published: date('published'),
  available: boolean('available').notNull().default(true),
  authorId: uuid('author_id').notNull().references((): AnyPgColumn => authors.id),
}, (table) => [
  index('ix_books_author_id').on(table.authorId),
  check('ck_books_genre', sql`${table.genre} IN ('novel', 'essay', 'poetry', 'science')`),
])

export const booksRelations = relations(books, ({ one, many }) => ({
  author: one(authors, { fields: [books.authorId], references: [authors.id], relationName: 'Book_author' }),
}))
