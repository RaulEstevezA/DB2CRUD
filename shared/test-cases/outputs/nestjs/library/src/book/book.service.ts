/**
 * Rules of books: what each operation checks and changes.
 */

import { Inject, Injectable } from '@nestjs/common'
import { AUTHOR_REPOSITORY, type AuthorRepository } from '../author/author.repository'
import { invalid, notFound } from '../common/errors'
import { type ListQuery, type ListResult } from '../common/listing'
import { type BookRecord, type CreateBookDto, type UpdateBookDto } from './book.dto'
import { BOOK_REPOSITORY, type BookRepository } from './book.repository'

@Injectable()
export class BookService {
  constructor(@Inject(BOOK_REPOSITORY) private readonly repository: BookRepository, @Inject(AUTHOR_REPOSITORY) private readonly authors: AuthorRepository) {}

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
  async createBook(values: CreateBookDto): Promise<BookRecord> {
    await this.checkReferences(values)
    return this.repository.add(values)
  }

  /** Replace a book: every field the client may send takes the value of the body. */
  async replaceBook(key: string, values: CreateBookDto): Promise<BookRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values)
  }

  /** Update part of a book: only the fields in the body change. */
  async updateBook(key: string, values: UpdateBookDto): Promise<BookRecord> {
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
