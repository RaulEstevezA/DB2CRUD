import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm'
import { Audited } from './base.js'

export enum Role {
  Reader = 'reader',
  Writer = 'writer',
  Editor = 'editor',
}

export const enum Priority {
  Low = 1,
  Normal,
  High = 5,
}

class Address {
  @Column() street!: string
  @Column() city!: string
}

@Entity({ schema: 'blog', comment: 'People who write' })
@Unique('uq_author_handle', ['handle'])
export class Author extends Audited {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ length: 40 })
  handle!: string

  @Column({ type: 'enum', enum: Role, enumName: 'author_role', default: Role.Reader })
  role!: Role

  @Column('text', { array: true, default: () => "'{}'" })
  aliases!: string[]

  @Column({ nullable: true, comment: 'Shown under the name' })
  bio?: string | null

  @Column(() => Address)
  address!: Address

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[]

  get display(): string {
    return `@${this.handle}`
  }
}

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id!: string

  @Column('jsonb', { default: {} })
  settings!: Record<string, unknown>

  @OneToOne(() => Author, { onDelete: 'CASCADE' })
  @JoinColumn()
  author!: Relation<Author>
}

@Entity()
@Index(['authorId', 'publishedAt'])
@Check('ck_post_words', 'words >= 0')
export class Post extends Audited {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 200 })
  slug!: string

  @Column('decimal', { precision: 6, scale: 1, default: 0 })
  rating!: string

  @Column({ type: 'simple-enum', enum: ['draft', 'live'], default: 'draft' })
  state!: 'draft' | 'live'

  @Column({ type: 'smallint', default: Priority.Normal })
  priority!: Priority

  @Column({ name: 'published_at', type: 'timestamp', nullable: true })
  publishedAt!: Date | null

  @Column({ type: 'int', default: 0 })
  words!: number

  @Column({ type: 'int', generatedType: 'STORED', asExpression: 'words / 200', insert: false, update: false })
  minutes!: number

  @ManyToOne(() => Author, (author) => author.posts, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'fk_posts_author' })
  author!: Relation<Author>

  @ManyToMany(() => Tag, (tag) => tag.posts)
  @JoinTable()
  tags!: Tag[]

  @OneToMany('Comment', 'post')
  comments!: Comment[]
}

@Entity()
export class Comment {
  @PrimaryColumn({ name: 'post_id' })
  postId!: number

  @PrimaryColumn()
  line!: number

  @Column('text')
  body!: string

  @Column({ type: 'bytea', nullable: true })
  attachment!: Buffer | null

  @ManyToOne('Post', 'comments', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'post_id' })
  post!: Post

  @ManyToOne(() => Comment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn([
    { name: 'parent_post_id', referencedColumnName: 'postId' },
    { name: 'parent_line', referencedColumnName: 'line' },
  ])
  parent?: Comment | null

  @ManyToOne(() => Author)
  reviewer?: Author
}

@Entity()
export class Tag {
  @PrimaryColumn({ length: 30 })
  name!: string

  @ManyToMany(() => Post, (post) => post.tags)
  posts!: Post[]
}
