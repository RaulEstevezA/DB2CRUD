/**
 * Rules of products: what each operation checks and changes.
 */

import { Inject, Injectable } from '@nestjs/common'
import { notFound } from '../common/errors'
import { type ListQuery, type ListResult } from '../common/listing'
import { type CreateProductDto, type ProductRecord, type UpdateProductDto } from './product.dto'
import { PRODUCT_REPOSITORY, type ProductRepository } from './product.repository'

@Injectable()
export class ProductService {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly repository: ProductRepository) {}

  private async find(key: number): Promise<ProductRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('product')
    return item
  }

  /** List products. */
  listProducts(query: ListQuery): Promise<ListResult<ProductRecord>> {
    return this.repository.list(query)
  }

  /** Get a product. */
  getProduct(key: number): Promise<ProductRecord> {
    return this.find(key)
  }

  /** Create a product. */
  async createProduct(values: CreateProductDto): Promise<ProductRecord> {
    return this.repository.add(values)
  }

  /** Replace a product: every field the client may send takes the value of the body. */
  async replaceProduct(key: number, values: CreateProductDto): Promise<ProductRecord> {
    await this.find(key)
    return this.repository.update(key, values)
  }

  /** Update part of a product: only the fields in the body change. */
  async updateProduct(key: number, values: UpdateProductDto): Promise<ProductRecord> {
    await this.find(key)
    return this.repository.update(key, values as Partial<ProductRecord>)
  }

  /** Delete a product. */
  async deleteProduct(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
