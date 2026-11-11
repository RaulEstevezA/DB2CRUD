/**
 * Module of categories: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { CategoryController } from './category.controller'
import { CATEGORY_REPOSITORY, InMemoryCategoryRepository } from './category.repository'
import { CategoryService } from './category.service'

@Module({
  controllers: [CategoryController],
  providers: [CategoryService, { provide: CATEGORY_REPOSITORY, useClass: InMemoryCategoryRepository }],
  exports: [CATEGORY_REPOSITORY],
})
export class CategoryModule {}
