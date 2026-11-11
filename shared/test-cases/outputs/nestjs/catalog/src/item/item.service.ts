/**
 * Rules of items: what each operation checks and changes.
 */

import { Inject, Injectable } from '@nestjs/common'
import { CATEGORY_REPOSITORY, type CategoryRepository } from '../category/category.repository'
import { invalid, notFound } from '../common/errors'
import { type ListQuery, type ListResult } from '../common/listing'
import { type CreateItemDto, type ItemRecord, type UpdateItemDto } from './item.dto'
import { ITEM_REPOSITORY, type ItemRepository } from './item.repository'

@Injectable()
export class ItemService {
  constructor(@Inject(ITEM_REPOSITORY) private readonly repository: ItemRepository, @Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository) {}

  private async find(key: number): Promise<ItemRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('item')
    return item
  }

  /** A reference must point to a stored item. */
  private async require(repository: { get(key: never): Promise<unknown> }, key: unknown, field: string, model: string): Promise<void> {
    if (key !== undefined && key !== null && (await repository.get(key as never)) === undefined) throw invalid(field, `No ${model} has this key`)
  }

  private async checkReferences(values: Partial<ItemRecord>): Promise<void> {
    await this.require(this.categories, values.categoryId, 'categoryId', 'Category')
  }

  /** List items. */
  listItems(query: ListQuery): Promise<ListResult<ItemRecord>> {
    return this.repository.list(query)
  }

  /** Get an item. */
  getItem(key: number): Promise<ItemRecord> {
    return this.find(key)
  }

  /** Create an item. */
  async createItem(values: CreateItemDto): Promise<ItemRecord> {
    await this.checkReferences(values)
    return this.repository.add(values)
  }

  /** Replace an item: every field the client may send takes the value of the body. */
  async replaceItem(key: number, values: CreateItemDto): Promise<ItemRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values)
  }

  /** Update part of an item: only the fields in the body change. */
  async updateItem(key: number, values: UpdateItemDto): Promise<ItemRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values as Partial<ItemRecord>)
  }

  /** Delete an item. */
  async deleteItem(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
