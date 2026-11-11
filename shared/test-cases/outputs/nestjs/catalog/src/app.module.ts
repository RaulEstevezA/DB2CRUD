/**
 * Root module: every resource module, and the database connection when there is one.
 */

import { Module } from '@nestjs/common'
import { CategoryModule } from './category/category.module'
import { ItemModule } from './item/item.module'

@Module({
  imports: [CategoryModule, ItemModule],
})
export class AppModule {}
