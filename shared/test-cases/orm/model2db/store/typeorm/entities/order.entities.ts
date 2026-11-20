// TypeORM entities written by Model2DB from Order. Review them before using them.
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm'

export enum OrderStatus {
  Pending = 'pending',
  Paid = 'paid',
  Shipped = 'shipped',
  Cancelled = 'cancelled',
}

@Entity({ name: 'customers' })
export class Customer {
  @PrimaryColumn({ name: 'id', type: 'bigint' })
  id!: string

  @Column({ name: 'name', type: 'text' })
  name!: string

  @Column({ name: 'email', type: 'text' })
  email!: string

  @Column({ name: 'password', type: 'text' })
  password!: string

  @Column({ name: 'phone', type: 'text', nullable: true })
  phone!: string | null

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column({ name: 'address_street', type: 'text' })
  addressStreet!: string

  @Column({ name: 'address_city', type: 'text' })
  addressCity!: string

  @Column({ name: 'address_postal_code', type: 'text' })
  addressPostalCode!: string

  @Column({ name: 'address_country', type: 'text' })
  addressCountry!: string
}

@Entity({ name: 'products' })
export class Product {
  @PrimaryColumn({ name: 'id', type: 'bigint' })
  id!: string

  @Column({ name: 'sku', type: 'text' })
  sku!: string

  @Column({ name: 'name', type: 'text' })
  name!: string

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null

  @Column({ name: 'price', type: 'double precision' })
  price!: number

  @Column({ name: 'stock', type: 'integer' })
  stock!: number

  @Column({ name: 'active', type: 'boolean' })
  active!: boolean
}

@Index('ix_order_lines_product_id', ['productId'])
@Index('ix_order_lines_order_id', ['orderId'])
@Entity({ name: 'order_lines' })
export class OrderLine {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id!: string

  @Column({ name: 'quantity', type: 'integer' })
  quantity!: number

  @Column({ name: 'unit_price', type: 'double precision' })
  unitPrice!: number

  @Column({ name: 'product_id', type: 'bigint' })
  productId!: string

  @Column({ name: 'order_id', type: 'bigint' })
  orderId!: string

  @ManyToOne(() => Product, { nullable: false })
  @JoinColumn({ name: 'product_id', referencedColumnName: 'id' })
  product!: Product

  @ManyToOne(() => Order, (other) => other.lines, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', referencedColumnName: 'id' })
  order!: Order
}

// TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
@Check('ck_orders_status', 'status IN (\'pending\', \'paid\', \'shipped\', \'cancelled\')')
@Index('ix_orders_customer_id', ['customerId'])
@Entity({ name: 'orders' })
export class Order {
  @PrimaryColumn({ name: 'id', type: 'bigint' })
  id!: string

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status!: OrderStatus

  @Column({ name: 'total', type: 'double precision' })
  total!: number

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date

  @Column({ name: 'customer_id', type: 'bigint' })
  customerId!: string

  @OneToMany(() => OrderLine, (other) => other.order)
  lines!: OrderLine[]

  @ManyToOne(() => Customer, { nullable: false })
  @JoinColumn({ name: 'customer_id', referencedColumnName: 'id' })
  customer!: Customer
}
