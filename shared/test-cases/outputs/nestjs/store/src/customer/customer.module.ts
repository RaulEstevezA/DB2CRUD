/**
 * Module of customers: its routes, its rules and the storage they use.
 */

import { Module } from '@nestjs/common'
import { CustomerController } from './customer.controller'
import { CUSTOMER_REPOSITORY, InMemoryCustomerRepository } from './customer.repository'
import { CustomerService } from './customer.service'

@Module({
  controllers: [CustomerController],
  providers: [CustomerService, { provide: CUSTOMER_REPOSITORY, useClass: InMemoryCustomerRepository }],
  exports: [CUSTOMER_REPOSITORY],
})
export class CustomerModule {}
