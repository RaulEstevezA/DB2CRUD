/**
 * Routes of products: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateProductDto, UpdateProductDto, toProduct, type Product } from './product.dto'
import { ProductService } from './product.service'

/** Query parameters of list products. */
class ListProductsQuery {
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
export class ProductController {
  constructor(@Inject(ProductService) private readonly service: ProductService) {}

  /** List products. */
  @Get('/products')
  @HttpCode(200)
  async listProducts(@Query() query: ListProductsQuery): Promise<{ items: Product[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listProducts({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toProduct), total, page: query.page, size: query.size }
  }

  /** Get a product. */
  @Get('/products/:id')
  @HttpCode(200)
  async getProduct(@Param('id', ParseIntPipe) key: number): Promise<Product> {
    return toProduct(await this.service.getProduct(key))
  }

  /** Create a product. */
  @Post('/products')
  @HttpCode(201)
  async createProduct(@Body() values: CreateProductDto): Promise<Product> {
    return toProduct(await this.service.createProduct(values))
  }

  /** Replace a product. */
  @Put('/products/:id')
  @HttpCode(200)
  async replaceProduct(@Param('id', ParseIntPipe) key: number, @Body() values: CreateProductDto): Promise<Product> {
    return toProduct(await this.service.replaceProduct(key, values))
  }

  /** Update part of a product. */
  @Patch('/products/:id')
  @HttpCode(200)
  async updateProduct(@Param('id', ParseIntPipe) key: number, @Body() values: UpdateProductDto): Promise<Product> {
    return toProduct(await this.service.updateProduct(key, values))
  }

  /** Delete a product. */
  @Delete('/products/:id')
  @HttpCode(204)
  async deleteProduct(@Param('id', ParseIntPipe) key: number): Promise<void> {
    await this.service.deleteProduct(key)
  }
}
