// Sequelize models written by Model2DB from Item. Review them before using them.
import { DataTypes, Model, Sequelize, type CreationOptional, type InferAttributes, type InferCreationAttributes, type NonAttribute } from 'sequelize'

export class Category extends Model<InferAttributes<Category>, InferCreationAttributes<Category>> {
  declare id: CreationOptional<string>
  declare name: string
  declare parentId: string
  declare parent?: NonAttribute<Category>
}

export class Item extends Model<InferAttributes<Item>, InferCreationAttributes<Item>> {
  declare id: CreationOptional<string>
  declare name: string
  declare price: string
  declare supplierEmail: string
  declare stock: number
  declare categoryId: string
  declare category?: NonAttribute<Category>
}

/** Defines every model and its associations on a Sequelize instance. */
export function initModels(sequelize: Sequelize): void {
  Category.init(
    {
      id: { type: DataTypes.BIGINT, field: 'id', primaryKey: true, autoIncrement: true, allowNull: false },
      name: { type: DataTypes.STRING(80), field: 'name', allowNull: false },
      parentId: { type: DataTypes.BIGINT, field: 'parent_id', allowNull: false },
    },
    { sequelize, tableName: 'categories', timestamps: false, indexes: [{ name: 'ix_categories_parent_id', unique: false, fields: ['parent_id'] }] },
  )
  Item.init(
    {
      id: { type: DataTypes.BIGINT, field: 'id', primaryKey: true, autoIncrement: true, allowNull: false },
      name: { type: DataTypes.STRING(120), field: 'name', allowNull: false },
      price: { type: DataTypes.DECIMAL(18, 2), field: 'price', allowNull: false },
      supplierEmail: { type: DataTypes.STRING(255), field: 'supplier_email', allowNull: false },
      stock: { type: DataTypes.INTEGER, field: 'stock', allowNull: false },
      categoryId: { type: DataTypes.BIGINT, field: 'category_id', allowNull: false },
    },
    { sequelize, tableName: 'items', timestamps: false, indexes: [{ name: 'ix_items_category_id', unique: false, fields: ['category_id'] }] },
  )
  Category.belongsTo(Category, { as: 'parent', foreignKey: 'parentId', targetKey: 'id' })
  Item.belongsTo(Category, { as: 'category', foreignKey: 'categoryId', targetKey: 'id' })
}
