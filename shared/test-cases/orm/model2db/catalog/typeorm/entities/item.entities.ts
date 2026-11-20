// TypeORM entities written by Model2DB from Item. Review them before using them.
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'

@Index('ix_categories_parent_id', ['parentId'])
@Entity({ name: 'categories' })
export class Category {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id!: string

  @Column({ name: 'name', type: 'varchar', length: 80 })
  name!: string

  @Column({ name: 'parent_id', type: 'bigint' })
  parentId!: string

  @ManyToOne(() => Category, { nullable: false })
  @JoinColumn({ name: 'parent_id', referencedColumnName: 'id' })
  parent!: Category
}

@Index('ix_items_category_id', ['categoryId'])
@Entity({ name: 'items' })
export class Item {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id!: string

  @Column({ name: 'name', type: 'varchar', length: 120 })
  name!: string

  @Column({ name: 'price', type: 'decimal', precision: 18, scale: 2 })
  price!: string

  @Column({ name: 'supplier_email', type: 'varchar', length: 255 })
  supplierEmail!: string

  @Column({ name: 'stock', type: 'int' })
  stock!: number

  @Column({ name: 'category_id', type: 'bigint' })
  categoryId!: string

  @ManyToOne(() => Category, { nullable: false })
  @JoinColumn({ name: 'category_id', referencedColumnName: 'id' })
  category!: Category
}
