/**
 * Routes of customers: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateCustomerDto, UpdateCustomerDto, toCustomer, type Customer } from './customer.dto'
import { CustomerService } from './customer.service'

/** Query parameters of list customers. */
class ListCustomersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20
}

@Controller()
export class CustomerController {
  constructor(@Inject(CustomerService) private readonly service: CustomerService) {}

  /** List customers. */
  @Get('/customers')
  @HttpCode(200)
  async listCustomers(@Query() query: ListCustomersQuery): Promise<{ items: Customer[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listCustomers({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toCustomer), total, page: query.page, size: query.size }
  }

  /** Get a customer. */
  @Get('/customers/:id')
  @HttpCode(200)
  async getCustomer(@Param('id', ParseIntPipe) key: number): Promise<Customer> {
    return toCustomer(await this.service.getCustomer(key))
  }

  /** Create a customer. */
  @Post('/customers')
  @HttpCode(201)
  async createCustomer(@Body() values: CreateCustomerDto): Promise<Customer> {
    return toCustomer(await this.service.createCustomer(values))
  }

  /** Replace a customer. */
  @Put('/customers/:id')
  @HttpCode(200)
  async replaceCustomer(@Param('id', ParseIntPipe) key: number, @Body() values: CreateCustomerDto): Promise<Customer> {
    return toCustomer(await this.service.replaceCustomer(key, values))
  }

  /** Update part of a customer. */
  @Patch('/customers/:id')
  @HttpCode(200)
  async updateCustomer(@Param('id', ParseIntPipe) key: number, @Body() values: UpdateCustomerDto): Promise<Customer> {
    return toCustomer(await this.service.updateCustomer(key, values))
  }

  /** Delete a customer. */
  @Delete('/customers/:id')
  @HttpCode(204)
  async deleteCustomer(@Param('id', ParseIntPipe) key: number): Promise<void> {
    await this.service.deleteCustomer(key)
  }
}
