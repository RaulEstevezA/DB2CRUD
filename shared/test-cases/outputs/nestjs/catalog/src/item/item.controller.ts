/**
 * Routes of items: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateItemDto, UpdateItemDto, toItem, type Item } from './item.dto'
import { ItemService } from './item.service'

/** Query parameters of list items. */
class ListItemsQuery {
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
export class ItemController {
  constructor(@Inject(ItemService) private readonly service: ItemService) {}

  /** List items. */
  @Get('/items')
  @HttpCode(200)
  async listItems(@Query() query: ListItemsQuery): Promise<{ items: Item[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listItems({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toItem), total, page: query.page, size: query.size }
  }

  /** Get an item. */
  @Get('/items/:id')
  @HttpCode(200)
  async getItem(@Param('id', ParseIntPipe) key: number): Promise<Item> {
    return toItem(await this.service.getItem(key))
  }

  /** Create an item. */
  @Post('/items')
  @HttpCode(201)
  async createItem(@Body() values: CreateItemDto): Promise<Item> {
    return toItem(await this.service.createItem(values))
  }

  /** Replace an item. */
  @Put('/items/:id')
  @HttpCode(200)
  async replaceItem(@Param('id', ParseIntPipe) key: number, @Body() values: CreateItemDto): Promise<Item> {
    return toItem(await this.service.replaceItem(key, values))
  }

  /** Update part of an item. */
  @Patch('/items/:id')
  @HttpCode(200)
  async updateItem(@Param('id', ParseIntPipe) key: number, @Body() values: UpdateItemDto): Promise<Item> {
    return toItem(await this.service.updateItem(key, values))
  }

  /** Delete an item. */
  @Delete('/items/:id')
  @HttpCode(204)
  async deleteItem(@Param('id', ParseIntPipe) key: number): Promise<void> {
    await this.service.deleteItem(key)
  }
}
