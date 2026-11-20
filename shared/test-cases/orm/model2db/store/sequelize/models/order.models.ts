// Sequelize models written by Model2DB from Order. Review them before using them.
import { DataTypes, Model, Sequelize, type CreationOptional, type InferAttributes, type InferCreationAttributes, type NonAttribute } from 'sequelize'

export enum OrderStatus {
  Pending = 'pending',
  Paid = 'paid',
  Shipped = 'shipped',
  Cancelled = 'cancelled',
}

export class Customer extends Model<InferAttributes<Customer>, InferCreationAttributes<Customer>> {
  declare id: string
  declare name: string
  declare email: string
  declare password: string
  declare phone: CreationOptional<string | null>
  declare createdAt: Date
  declare addressStreet: string
  declare addressCity: string
  declare addressPostalCode: string
  declare addressCountry: string
}

export class Product extends Model<InferAttributes<Product>, InferCreationAttributes<Product>> {
  declare id: string
  declare sku: string
  declare name: string
  declare description: CreationOptional<string | null>
  declare price: number
  declare stock: number
  declare active: boolean
}

export class OrderLine extends Model<InferAttributes<OrderLine>, InferCreationAttributes<OrderLine>> {
  declare id: CreationOptional<string>
  declare quantity: number
  declare unitPrice: number
  declare productId: string
  declare orderId: string
  declare product?: NonAttribute<Product>
  declare order?: NonAttribute<Order>
}

// TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
export class Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
  declare id: string
  declare status: OrderStatus
  declare total: number
  declare notes: CreationOptional<string | null>
  declare createdAt: Date
  declare updatedAt: Date
  declare customerId: string
  declare lines?: NonAttribute<OrderLine[]>
  declare customer?: NonAttribute<Customer>
}

/** Defines every model and its associations on a Sequelize instance. */
export function initModels(sequelize: Sequelize): void {
  Customer.init(
    {
      id: { type: DataTypes.BIGINT, field: 'id', primaryKey: true, allowNull: false },
      name: { type: DataTypes.TEXT, field: 'name', allowNull: false },
      email: { type: DataTypes.TEXT, field: 'email', allowNull: false },
      password: { type: DataTypes.TEXT, field: 'password', allowNull: false },
      phone: { type: DataTypes.TEXT, field: 'phone', allowNull: true },
      createdAt: { type: DataTypes.DATE, field: 'created_at', allowNull: false },
      addressStreet: { type: DataTypes.TEXT, field: 'address_street', allowNull: false },
      addressCity: { type: DataTypes.TEXT, field: 'address_city', allowNull: false },
      addressPostalCode: { type: DataTypes.TEXT, field: 'address_postal_code', allowNull: false },
      addressCountry: { type: DataTypes.TEXT, field: 'address_country', allowNull: false },
    },
    { sequelize, tableName: 'customers', timestamps: false },
  )
  Product.init(
    {
      id: { type: DataTypes.BIGINT, field: 'id', primaryKey: true, allowNull: false },
      sku: { type: DataTypes.TEXT, field: 'sku', allowNull: false },
      name: { type: DataTypes.TEXT, field: 'name', allowNull: false },
      description: { type: DataTypes.TEXT, field: 'description', allowNull: true },
      price: { type: DataTypes.DOUBLE, field: 'price', allowNull: false },
      stock: { type: DataTypes.INTEGER, field: 'stock', allowNull: false },
      active: { type: DataTypes.BOOLEAN, field: 'active', allowNull: false },
    },
    { sequelize, tableName: 'products', timestamps: false },
  )
  OrderLine.init(
    {
      id: { type: DataTypes.BIGINT, field: 'id', primaryKey: true, autoIncrement: true, allowNull: false },
      quantity: { type: DataTypes.INTEGER, field: 'quantity', allowNull: false },
      unitPrice: { type: DataTypes.DOUBLE, field: 'unit_price', allowNull: false },
      productId: { type: DataTypes.BIGINT, field: 'product_id', allowNull: false },
      orderId: { type: DataTypes.BIGINT, field: 'order_id', allowNull: false },
    },
    { sequelize, tableName: 'order_lines', timestamps: false, indexes: [{ name: 'ix_order_lines_product_id', unique: false, fields: ['product_id'] }, { name: 'ix_order_lines_order_id', unique: false, fields: ['order_id'] }] },
  )
  Order.init(
    {
      id: { type: DataTypes.BIGINT, field: 'id', primaryKey: true, allowNull: false },
      status: { type: DataTypes.STRING(20), field: 'status', allowNull: false, validate: { isIn: [['pending', 'paid', 'shipped', 'cancelled']] } },
      total: { type: DataTypes.DOUBLE, field: 'total', allowNull: false },
      notes: { type: DataTypes.TEXT, field: 'notes', allowNull: true },
      createdAt: { type: DataTypes.DATE, field: 'created_at', allowNull: false },
      updatedAt: { type: DataTypes.DATE, field: 'updated_at', allowNull: false },
      customerId: { type: DataTypes.BIGINT, field: 'customer_id', allowNull: false },
    },
    { sequelize, tableName: 'orders', timestamps: false, indexes: [{ name: 'ix_orders_customer_id', unique: false, fields: ['customer_id'] }] },
  )
  OrderLine.belongsTo(Product, { as: 'product', foreignKey: 'productId', targetKey: 'id' })
  OrderLine.belongsTo(Order, { as: 'order', foreignKey: 'orderId', targetKey: 'id', onDelete: 'CASCADE' })
  Order.hasMany(OrderLine, { as: 'lines', foreignKey: 'orderId' })
  Order.belongsTo(Customer, { as: 'customer', foreignKey: 'customerId', targetKey: 'id' })
}
