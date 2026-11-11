/**
 * Rules of books: what each operation checks and changes.
 */

import { invalid, notFound } from '../errors.js'
import { type ListQuery, type ListResult } from '../listing.js'
import { type AuthorRepository } from '../repositories/author.js'
import { type BookRepository } from '../repositories/book.js'
import { type BookCreate, type BookRecord, type BookUpdate } from '../schemas/book.js'

export class BookService {
  constructor(private readonly repository: BookRepository, private readonly authors: AuthorRepository) {}

  private async find(key: string): Promise<BookRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('book')
    return item
  }

  /** A reference must point to a stored item. */
  private async require(repository: { get(key: never): Promise<unknown> }, key: unknown, field: string, model: string): Promise<void> {
    if (key !== undefined && key !== null && (await repository.get(key as never)) === undefined) throw invalid(field, `No ${model} has this key`)
  }

  private async checkReferences(values: Partial<BookRecord>): Promise<void> {
    await this.require(this.authors, values.authorId, 'authorId', 'Author')
  }

  /** List books. */
  listBooks(query: ListQuery): Promise<ListResult<BookRecord>> {
    return this.repository.list(query)
  }

  /** Get a book. */
  getBook(key: string): Promise<BookRecord> {
    return this.find(key)
  }

  /** Create a book. */
  async createBook(values: BookCreate): Promise<BookRecord> {
    await this.checkReferences(values)
    return this.repository.add(values)
  }

  /** Replace a book: every field the client may send takes the value of the body. */
  async replaceBook(key: string, values: BookCreate): Promise<BookRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values)
  }

  /** Update part of a book: only the fields in the body change. */
  async updateBook(key: string, values: BookUpdate): Promise<BookRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values as Partial<BookRecord>)
  }

  /** Delete a book. */
  async deleteBook(key: string): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
