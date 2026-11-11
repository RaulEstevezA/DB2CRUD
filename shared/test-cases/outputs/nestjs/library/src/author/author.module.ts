/**
 * Module of authors: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { AuthorController } from './author.controller'
import { AUTHOR_REPOSITORY, InMemoryAuthorRepository } from './author.repository'
import { AuthorService } from './author.service'

@Module({
  controllers: [AuthorController],
  providers: [AuthorService, { provide: AUTHOR_REPOSITORY, useClass: InMemoryAuthorRepository }],
  exports: [AUTHOR_REPOSITORY],
})
export class AuthorModule {}
