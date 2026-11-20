import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('user_role', ['reader', 'writer', 'admin'])
const content = pgSchema('content')

export const users = pgTable(
  'users',
  {
    id: uuid().defaultRandom().primaryKey(),
    email: varchar({ length: 200 }).notNull().unique('uq_users_email'),
    role: roleEnum('role').notNull().default('reader'),
    nickname: text('nickname', { enum: ['ana', 'bo'] }),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    settings: jsonb('settings').default(sql`'{}'::jsonb`),
    $extra: text('$extra'),
  },
  (table) => ({
    emailLower: uniqueIndex('ix_users_email_lower').on(table.email, table.role),
  }),
)

export const posts = content.table(
  'posts',
  {
    id: serial('id').primaryKey(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    title: varchar('title', { length: 160 }).notNull(),
    words: integer('words').notNull().default(0),
    minutes: integer('minutes').generatedAlwaysAs(sql`words / 200`),
    score: doublePrecision('score'),
    price: numeric('price', { precision: 8, scale: 2 }),
    published: boolean('published').default(false),
    tags: text('tags').array(),
    replyTo: integer('reply_to').references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),
    code: char('code', { length: 4 }),
    readAt: time('read_at'),
    rank: smallint('rank').$defaultFn(() => 1),
  },
  (t) => [check('posts_words_check', sql`${t.words} >= 0`)],
)

export const postLikes = pgTable(
  'post_likes',
  {
    postId: integer('post_id').notNull().references(() => posts.id),
    userId: uuid('user_id').notNull().references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] })],
)

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  replies: many(posts, { relationName: 'thread' }),
  parent: one(posts, { fields: [posts.replyTo], references: [posts.id], relationName: 'thread' }),
}))
