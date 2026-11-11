/**
 * Root module: every resource module, and the database connection when there is one.
 */

import { Module } from '@nestjs/common'
import { CustomerModule } from './customer/customer.module'
import { OrderModule } from './order/order.module'
import { ProductModule } from './product/product.module'

@Module({
  imports: [CustomerModule, ProductModule, OrderModule],
})
export class AppModule {}
