// Sequelize models written by Model2DB from Book. Review them before using them.
import { DataTypes, Model, Sequelize, type CreationOptional, type InferAttributes, type InferCreationAttributes, type NonAttribute } from 'sequelize'

export enum Genre {
  NOVEL = 'novel',
  ESSAY = 'essay',
  POETRY = 'poetry',
  SCIENCE = 'science',
}

export class Author extends Model<InferAttributes<Author>, InferCreationAttributes<Author>> {
  declare id: string
  declare name: string
  declare email: CreationOptional<string | null>
  declare born: CreationOptional<Date | null>
}

// TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
export class Book extends Model<InferAttributes<Book>, InferCreationAttributes<Book>> {
  declare id: string
  declare title: string
  declare isbn: string
  declare genre: Genre
  declare pages: number
  declare published: CreationOptional<Date | null>
  declare available: CreationOptional<boolean>
  declare authorId: string
  declare author?: NonAttribute<Author>
}

/** Defines every model and its associations on a Sequelize instance. */
export function initModels(sequelize: Sequelize): void {
  Author.init(
    {
      id: { type: DataTypes.UUID, field: 'id', primaryKey: true, allowNull: false },
      name: { type: DataTypes.STRING(120), field: 'name', allowNull: false },
      email: { type: DataTypes.TEXT, field: 'email', allowNull: true },
      born: { type: DataTypes.DATEONLY, field: 'born', allowNull: true },
    },
    { sequelize, tableName: 'authors', timestamps: false },
  )
  Book.init(
    {
      id: { type: DataTypes.UUID, field: 'id', primaryKey: true, allowNull: false },
      title: { type: DataTypes.STRING(200), field: 'title', allowNull: false },
      isbn: { type: DataTypes.TEXT, field: 'isbn', allowNull: false },
      genre: { type: DataTypes.STRING(20), field: 'genre', allowNull: false, validate: { isIn: [['novel', 'essay', 'poetry', 'science']] } },
      pages: { type: DataTypes.INTEGER, field: 'pages', allowNull: false },
      published: { type: DataTypes.DATEONLY, field: 'published', allowNull: true },
      available: { type: DataTypes.BOOLEAN, field: 'available', allowNull: false, defaultValue: true },
      authorId: { type: DataTypes.UUID, field: 'author_id', allowNull: false },
    },
    { sequelize, tableName: 'books', timestamps: false, indexes: [{ name: 'ix_books_author_id', unique: false, fields: ['author_id'] }] },
  )
  Book.belongsTo(Author, { as: 'author', foreignKey: 'authorId', targetKey: 'id' })
}
