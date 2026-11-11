/**
 * Rules of authors: what each operation checks and changes.
 */

import { Inject, Injectable } from '@nestjs/common'
import { notFound } from '../common/errors'
import { type ListQuery, type ListResult } from '../common/listing'
import { type AuthorRecord, type CreateAuthorDto, type UpdateAuthorDto } from './author.dto'
import { AUTHOR_REPOSITORY, type AuthorRepository } from './author.repository'

@Injectable()
export class AuthorService {
  constructor(@Inject(AUTHOR_REPOSITORY) private readonly repository: AuthorRepository) {}

  private async find(key: string): Promise<AuthorRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('author')
    return item
  }

  /** List authors. */
  listAuthors(query: ListQuery): Promise<ListResult<AuthorRecord>> {
    return this.repository.list(query)
  }

  /** Get an author. */
  getAuthor(key: string): Promise<AuthorRecord> {
    return this.find(key)
  }

  /** Create an author. */
  async createAuthor(values: CreateAuthorDto): Promise<AuthorRecord> {
    return this.repository.add(values)
  }

  /** Replace an author: every field the client may send takes the value of the body. */
  async replaceAuthor(key: string, values: CreateAuthorDto): Promise<AuthorRecord> {
    await this.find(key)
    return this.repository.update(key, values)
  }

  /** Update part of an author: only the fields in the body change. */
  async updateAuthor(key: string, values: UpdateAuthorDto): Promise<AuthorRecord> {
    await this.find(key)
    return this.repository.update(key, values as Partial<AuthorRecord>)
  }

  /** Delete an author. */
  async deleteAuthor(key: string): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
