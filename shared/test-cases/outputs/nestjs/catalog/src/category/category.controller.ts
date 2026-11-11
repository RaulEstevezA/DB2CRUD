/**
 * Routes of categories: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateCategoryDto, UpdateCategoryDto, toCategory, type Category } from './category.dto'
import { CategoryService } from './category.service'

/** Query parameters of list categories. */
class ListCategoriesQuery {
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
export class CategoryController {
  constructor(@Inject(CategoryService) private readonly service: CategoryService) {}

  /** List categories. */
  @Get('/categories')
  @HttpCode(200)
  async listCategories(@Query() query: ListCategoriesQuery): Promise<{ items: Category[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listCategories({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toCategory), total, page: query.page, size: query.size }
  }

  /** Get a category. */
  @Get('/categories/:id')
  @HttpCode(200)
  async getCategory(@Param('id', ParseIntPipe) key: number): Promise<Category> {
    return toCategory(await this.service.getCategory(key))
  }

  /** Create a category. */
  @Post('/categories')
  @HttpCode(201)
  async createCategory(@Body() values: CreateCategoryDto): Promise<Category> {
    return toCategory(await this.service.createCategory(values))
  }

  /** Replace a category. */
  @Put('/categories/:id')
  @HttpCode(200)
  async replaceCategory(@Param('id', ParseIntPipe) key: number, @Body() values: CreateCategoryDto): Promise<Category> {
    return toCategory(await this.service.replaceCategory(key, values))
  }

  /** Update part of a category. */
  @Patch('/categories/:id')
  @HttpCode(200)
  async updateCategory(@Param('id', ParseIntPipe) key: number, @Body() values: UpdateCategoryDto): Promise<Category> {
    return toCategory(await this.service.updateCategory(key, values))
  }

  /** Delete a category. */
  @Delete('/categories/:id')
  @HttpCode(204)
  async deleteCategory(@Param('id', ParseIntPipe) key: number): Promise<void> {
    await this.service.deleteCategory(key)
  }
}
