/**
 * Module of books: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { AuthorModule } from '../author/author.module'
import { BookController } from './book.controller'
import { BOOK_REPOSITORY, InMemoryBookRepository } from './book.repository'
import { BookService } from './book.service'

@Module({
  imports: [AuthorModule],
  controllers: [BookController],
  providers: [BookService, { provide: BOOK_REPOSITORY, useClass: InMemoryBookRepository }],
  exports: [BOOK_REPOSITORY],
})
export class BookModule {}
