/**
 * Rules of products: what each operation checks and changes.
 */

import { notFound } from '../errors.js'
import { type ListQuery, type ListResult } from '../listing.js'
import { type ProductRepository } from '../repositories/product.js'
import { type ProductCreate, type ProductRecord, type ProductUpdate } from '../schemas/product.js'

export class ProductService {
  constructor(private readonly repository: ProductRepository) {}

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
  async createProduct(values: ProductCreate): Promise<ProductRecord> {
    return this.repository.add(values)
  }

  /** Replace a product: every field the client may send takes the value of the body. */
  async replaceProduct(key: number, values: ProductCreate): Promise<ProductRecord> {
    await this.find(key)
    return this.repository.update(key, values)
  }

  /** Update part of a product: only the fields in the body change. */
  async updateProduct(key: number, values: ProductUpdate): Promise<ProductRecord> {
    await this.find(key)
    return this.repository.update(key, values as Partial<ProductRecord>)
  }

  /** Delete a product. */
  async deleteProduct(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
