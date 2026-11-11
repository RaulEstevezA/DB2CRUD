/**
 * Routes of books: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateBookDto, UpdateBookDto, toBook, type Book } from './book.dto'
import { BookService } from './book.service'

/** Query parameters of list books. */
class ListBooksQuery {
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
export class BookController {
  constructor(@Inject(BookService) private readonly service: BookService) {}

  /** List books. */
  @Get('/books')
  @HttpCode(200)
  async listBooks(@Query() query: ListBooksQuery): Promise<{ items: Book[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listBooks({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toBook), total, page: query.page, size: query.size }
  }

  /** Get a book. */
  @Get('/books/:id')
  @HttpCode(200)
  async getBook(@Param('id', ParseUUIDPipe) key: string): Promise<Book> {
    return toBook(await this.service.getBook(key))
  }

  /** Create a book. */
  @Post('/books')
  @HttpCode(201)
  async createBook(@Body() values: CreateBookDto): Promise<Book> {
    return toBook(await this.service.createBook(values))
  }

  /** Replace a book. */
  @Put('/books/:id')
  @HttpCode(200)
  async replaceBook(@Param('id', ParseUUIDPipe) key: string, @Body() values: CreateBookDto): Promise<Book> {
    return toBook(await this.service.replaceBook(key, values))
  }

  /** Update part of a book. */
  @Patch('/books/:id')
  @HttpCode(200)
  async updateBook(@Param('id', ParseUUIDPipe) key: string, @Body() values: UpdateBookDto): Promise<Book> {
    return toBook(await this.service.updateBook(key, values))
  }

  /** Delete a book. */
  @Delete('/books/:id')
  @HttpCode(204)
  async deleteBook(@Param('id', ParseUUIDPipe) key: string): Promise<void> {
    await this.service.deleteBook(key)
  }
}
