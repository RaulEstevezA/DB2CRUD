/**
 * Rules of categories: what each operation checks and changes.
 */

import { Inject, Injectable } from '@nestjs/common'
import { invalid, notFound } from '../common/errors'
import { type ListQuery, type ListResult } from '../common/listing'
import { type CategoryRecord, type CreateCategoryDto, type UpdateCategoryDto } from './category.dto'
import { CATEGORY_REPOSITORY, type CategoryRepository } from './category.repository'

@Injectable()
export class CategoryService {
  constructor(@Inject(CATEGORY_REPOSITORY) private readonly repository: CategoryRepository) {}

  private async find(key: number): Promise<CategoryRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('category')
    return item
  }

  /** A reference must point to a stored item. */
  private async require(repository: { get(key: never): Promise<unknown> }, key: unknown, field: string, model: string): Promise<void> {
    if (key !== undefined && key !== null && (await repository.get(key as never)) === undefined) throw invalid(field, `No ${model} has this key`)
  }

  private async checkReferences(values: Partial<CategoryRecord>): Promise<void> {
    await this.require(this.repository, values.parentId, 'parentId', 'Category')
  }

  /** List categories. */
  listCategories(query: ListQuery): Promise<ListResult<CategoryRecord>> {
    return this.repository.list(query)
  }

  /** Get a category. */
  getCategory(key: number): Promise<CategoryRecord> {
    return this.find(key)
  }

  /** Create a category. */
  async createCategory(values: CreateCategoryDto): Promise<CategoryRecord> {
    await this.checkReferences(values)
    return this.repository.add(values)
  }

  /** Replace a category: every field the client may send takes the value of the body. */
  async replaceCategory(key: number, values: CreateCategoryDto): Promise<CategoryRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values)
  }

  /** Update part of a category: only the fields in the body change. */
  async updateCategory(key: number, values: UpdateCategoryDto): Promise<CategoryRecord> {
    await this.find(key)
    await this.checkReferences(values)
    return this.repository.update(key, values as Partial<CategoryRecord>)
  }

  /** Delete a category. */
  async deleteCategory(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
