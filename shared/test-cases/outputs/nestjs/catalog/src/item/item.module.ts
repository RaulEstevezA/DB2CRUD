/**
 * Module of items: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { CategoryModule } from '../category/category.module'
import { ItemController } from './item.controller'
import { ITEM_REPOSITORY, InMemoryItemRepository } from './item.repository'
import { ItemService } from './item.service'

@Module({
  imports: [CategoryModule],
  controllers: [ItemController],
  providers: [ItemService, { provide: ITEM_REPOSITORY, useClass: InMemoryItemRepository }],
  exports: [ITEM_REPOSITORY],
})
export class ItemModule {}
