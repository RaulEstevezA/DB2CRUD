/**
 * Module of products: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { ProductController } from './product.controller'
import { InMemoryProductRepository, PRODUCT_REPOSITORY } from './product.repository'
import { ProductService } from './product.service'

@Module({
  controllers: [ProductController],
  providers: [ProductService, { provide: PRODUCT_REPOSITORY, useClass: InMemoryProductRepository }],
  exports: [PRODUCT_REPOSITORY],
})
export class ProductModule {}
