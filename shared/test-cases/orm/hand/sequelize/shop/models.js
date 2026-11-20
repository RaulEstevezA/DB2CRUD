const { DataTypes, Model, Sequelize, fn, literal } = require('sequelize')
const { sequelize } = require('./db')

class User extends Model {}
User.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    email: { type: DataTypes.STRING, allowNull: false, unique: 'uq_users_email', validate: { isEmail: true } },
    displayName: { type: DataTypes.STRING(80), allowNull: false, validate: { len: [2, 80] } },
    role: { type: DataTypes.ENUM('customer', 'staff'), allowNull: false, defaultValue: 'customer' },
    karma: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0, validate: { min: 0, max: { args: 1000, msg: 'Too much' } } },
    fullName: { type: DataTypes.VIRTUAL, get() { return this.displayName } },
  },
  { sequelize, modelName: 'User', paranoid: true },
)

const Address = sequelize.define('Address', {
  street: DataTypes.TEXT,
  city: { type: DataTypes.STRING(60), allowNull: false },
  tags: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: [] },
})

const Product = sequelize.define(
  'product',
  {
    sku: { type: DataTypes.CHAR(12), primaryKey: true },
    price: { type: DataTypes.DECIMAL(8, 2), allowNull: false, validate: { isIn: { args: [[1, 5, 10]], msg: 'Not a price' } } },
    stock: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: literal('0') },
    details: { type: DataTypes.JSONB, defaultValue: { color: 'red', sizes: [1, 2] } },
    addedOn: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
    checkedAt: { type: DataTypes.DATE(3), defaultValue: fn('now') },
    picture: DataTypes.BLOB('long'),
    rating: DataTypes.FLOAT,
  },
  {
    freezeTableName: true,
    timestamps: false,
    schema: 'store',
    comment: 'What the shop sells',
    indexes: [{ unique: true, fields: ['price', { name: 'stock' }] }, { name: 'ix_product_added', fields: ['addedOn'] }],
  },
)

const Order = sequelize.define('Order', {
  placedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: 'id' }, onDelete: 'CASCADE' },
  note: { type: DataTypes.TEXT, comment: 'Left by the customer' },
}, { createdAt: 'opened_at', updatedAt: false })

User.hasMany(Order, { as: 'orders', foreignKey: 'userId' })
Order.belongsTo(User, { as: 'buyer', foreignKey: 'userId' })
User.hasOne(Address, { onDelete: 'SET NULL' })
Address.belongsTo(User)
Order.belongsToMany(Product, { through: 'order_items', foreignKey: 'order_id', otherKey: 'product_sku' })
Product.belongsToMany(Order, { through: 'order_items', foreignKey: 'product_sku', otherKey: 'order_id' })
Order.belongsTo(Order, { as: 'replaces', foreignKey: { name: 'replacesId', allowNull: true }, onDelete: 'SET NULL' })

module.exports = { User, Address, Product, Order }
