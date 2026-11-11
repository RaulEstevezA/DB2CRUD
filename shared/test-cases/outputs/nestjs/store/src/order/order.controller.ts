/**
 * Routes of orders: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateOrderDto, UpdateOrderDto, toOrder, type Order } from './order.dto'
import { OrderService } from './order.service'

/** Query parameters of list orders. */
class ListOrdersQuery {
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
export class OrderController {
  constructor(@Inject(OrderService) private readonly service: OrderService) {}

  /** List orders. */
  @Get('/orders')
  @HttpCode(200)
  async listOrders(@Query() query: ListOrdersQuery): Promise<{ items: Order[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listOrders({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toOrder), total, page: query.page, size: query.size }
  }

  /** Get an order. */
  @Get('/orders/:id')
  @HttpCode(200)
  async getOrder(@Param('id', ParseIntPipe) key: number): Promise<Order> {
    return toOrder(await this.service.getOrder(key))
  }

  /** Create an order. */
  @Post('/orders')
  @HttpCode(201)
  async createOrder(@Body() values: CreateOrderDto): Promise<Order> {
    return toOrder(await this.service.createOrder(values))
  }

  /** Replace an order. */
  @Put('/orders/:id')
  @HttpCode(200)
  async replaceOrder(@Param('id', ParseIntPipe) key: number, @Body() values: CreateOrderDto): Promise<Order> {
    return toOrder(await this.service.replaceOrder(key, values))
  }

  /** Update part of an order. */
  @Patch('/orders/:id')
  @HttpCode(200)
  async updateOrder(@Param('id', ParseIntPipe) key: number, @Body() values: UpdateOrderDto): Promise<Order> {
    return toOrder(await this.service.updateOrder(key, values))
  }

  /** Delete an order. */
  @Delete('/orders/:id')
  @HttpCode(204)
  async deleteOrder(@Param('id', ParseIntPipe) key: number): Promise<void> {
    await this.service.deleteOrder(key)
  }
}
