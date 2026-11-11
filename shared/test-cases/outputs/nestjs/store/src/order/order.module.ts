/**
 * Module of orders: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { CustomerModule } from '../customer/customer.module'
import { ProductModule } from '../product/product.module'
import { OrderController } from './order.controller'
import { InMemoryOrderRepository, ORDER_REPOSITORY } from './order.repository'
import { OrderService } from './order.service'

@Module({
  imports: [CustomerModule, ProductModule],
  controllers: [OrderController],
  providers: [OrderService, { provide: ORDER_REPOSITORY, useClass: InMemoryOrderRepository }],
  exports: [ORDER_REPOSITORY],
})
export class OrderModule {}
