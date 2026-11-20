// TypeORM entities written by Model2DB from Book. Review them before using them.
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm'

export enum Genre {
  NOVEL = 'novel',
  ESSAY = 'essay',
  POETRY = 'poetry',
  SCIENCE = 'science',
}

@Entity({ name: 'authors' })
export class Author {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string

  @Column({ name: 'name', type: 'varchar', length: 120 })
  name!: string

  @Column({ name: 'email', type: 'text', nullable: true })
  email!: string | null

  @Column({ name: 'born', type: 'date', nullable: true })
  born!: Date | null
}

// TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
@Check('ck_books_genre', 'genre IN (\'novel\', \'essay\', \'poetry\', \'science\')')
@Index('ix_books_author_id', ['authorId'])
@Entity({ name: 'books' })
export class Book {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string

  @Column({ name: 'title', type: 'varchar', length: 200 })
  title!: string

  @Column({ name: 'isbn', type: 'text' })
  isbn!: string

  @Column({ name: 'genre', type: 'varchar', length: 20 })
  genre!: Genre

  @Column({ name: 'pages', type: 'integer' })
  pages!: number

  @Column({ name: 'published', type: 'date', nullable: true })
  published!: Date | null

  @Column({ name: 'available', type: 'boolean', default: true })
  available!: boolean

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string

  @ManyToOne(() => Author, { nullable: false })
  @JoinColumn({ name: 'author_id', referencedColumnName: 'id' })
  author!: Author
}
