// Mongoose schemas written by Model2DB from Author. Review them before using them.
import { Schema, model } from 'mongoose'

const authorSchema = new Schema(
  {
    _id: { type: Number, default: null },
    name: { type: String, required: true },
    email: { type: String, required: true },
  },
  { collection: 'authors', versionKey: false },
)
authorSchema.index({ 'email': 1 }, { name: 'uq_authors_email', unique: true })

const shelfSchema = new Schema(
  {
    room: { type: String, required: true },
    row: { type: Number, default: null },
  },
  { _id: false },
)

const tagSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
  },
  { _id: false },
)

// TODO: does the application read "Book" by author, ordered by publishedOn desc? Accept the query in the design to index it.
const bookSchema = new Schema(
  {
    _id: { type: Number, default: null },
    isbn: { type: String, required: true },
    title: { type: String, required: true },
    author: { type: Number, ref: 'Author' },
    price: { type: Schema.Types.Decimal128, required: true },
    published_on: { type: Date, required: true },
    genre: { type: String, required: true, enum: ['FICTION', 'ESSAY', 'POETRY', 'SCIENCE'] },
    shelf: { type: shelfSchema, required: true },
    tags: [tagSchema],
  },
  { collection: 'books', versionKey: false },
)
bookSchema.index({ 'isbn': 1 }, { name: 'uq_books_isbn', unique: true })
bookSchema.index({ 'author': 1 }, { name: 'ix_books_author' })

export const Author = model('Author', authorSchema)
export const Book = model('Book', bookSchema)
