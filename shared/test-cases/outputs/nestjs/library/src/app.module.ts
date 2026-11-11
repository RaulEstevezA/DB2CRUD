/**
 * Root module: every resource module, and the database connection when there is one.
 */

import { Module } from '@nestjs/common'
import { AuthorModule } from './author/author.module'
import { BookModule } from './book/book.module'

@Module({
  imports: [AuthorModule, BookModule],
})
export class AppModule {}
