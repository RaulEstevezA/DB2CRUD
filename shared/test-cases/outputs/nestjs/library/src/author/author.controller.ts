/**
 * Routes of authors: HTTP in, service calls, HTTP out.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { parseSort } from '../common/listing'
import { CreateAuthorDto, UpdateAuthorDto, toAuthor, type Author } from './author.dto'
import { AuthorService } from './author.service'

/** Query parameters of list authors. */
class ListAuthorsQuery {
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
export class AuthorController {
  constructor(@Inject(AuthorService) private readonly service: AuthorService) {}

  /** List authors. */
  @Get('/authors')
  @HttpCode(200)
  async listAuthors(@Query() query: ListAuthorsQuery): Promise<{ items: Author[]; total: number; page: number; size: number }> {
    const filters = {}
    const { items, total } = await this.service.listAuthors({ filters, sort: undefined, offset: (query.page - 1) * query.size, limit: query.size })
    return { items: items.map(toAuthor), total, page: query.page, size: query.size }
  }

  /** Get an author. */
  @Get('/authors/:id')
  @HttpCode(200)
  async getAuthor(@Param('id', ParseUUIDPipe) key: string): Promise<Author> {
    return toAuthor(await this.service.getAuthor(key))
  }

  /** Create an author. */
  @Post('/authors')
  @HttpCode(201)
  async createAuthor(@Body() values: CreateAuthorDto): Promise<Author> {
    return toAuthor(await this.service.createAuthor(values))
  }

  /** Replace an author. */
  @Put('/authors/:id')
  @HttpCode(200)
  async replaceAuthor(@Param('id', ParseUUIDPipe) key: string, @Body() values: CreateAuthorDto): Promise<Author> {
    return toAuthor(await this.service.replaceAuthor(key, values))
  }

  /** Update part of an author. */
  @Patch('/authors/:id')
  @HttpCode(200)
  async updateAuthor(@Param('id', ParseUUIDPipe) key: string, @Body() values: UpdateAuthorDto): Promise<Author> {
    return toAuthor(await this.service.updateAuthor(key, values))
  }

  /** Delete an author. */
  @Delete('/authors/:id')
  @HttpCode(204)
  async deleteAuthor(@Param('id', ParseUUIDPipe) key: string): Promise<void> {
    await this.service.deleteAuthor(key)
  }
}
