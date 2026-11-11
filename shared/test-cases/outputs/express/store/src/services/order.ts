/**
 * Rules of orders: what each operation checks and changes.
 */

import { invalid, notFound } from '../errors.js'
import { type ListQuery, type ListResult } from '../listing.js'
import { type CustomerRepository } from '../repositories/customer.js'
import { type OrderRepository } from '../repositories/order.js'
import { type ProductRepository } from '../repositories/product.js'
import { type OrderCreate, type OrderRecord, type OrderUpdate } from '../schemas/order.js'

export class OrderService {
  constructor(private readonly repository: OrderRepository, private readonly customers: CustomerRepository, private readonly products: ProductRepository) {}

  private async find(key: number): Promise<OrderRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('order')
    return item
  }

  /** A reference must point to a stored item. */
  private async require(repository: { get(key: never): Promise<unknown> }, key: unknown, field: string, model: string): Promise<void> {
    if (key !== undefined && key !== null && (await repository.get(key as never)) === undefined) throw invalid(field, `No ${model} has this key`)
  }

  private async checkReferences(values: Partial<OrderRecord>): Promise<void> {
    await this.require(this.customers, values.customerId, 'customerId', 'Customer')
    for (const item0 of values.lines ?? []) {
      await this.require(this.products, item0.productId, 'lines.productId', 'Product')
    }
  }

  /** List orders. */
  listOrders(query: ListQuery): Promise<ListResult<OrderRecord>> {
    return this.repository.list(query)
  }

  /** Get an order. */
  getOrder(key: number): Promise<OrderRecord> {
    return this.find(key)
  }

  /** Create an order. */
  async createOrder(values: OrderCreate): Promise<OrderRecord> {
    await this.checkReferences(values)
    const now = new Date().toISOString()
    return this.repository.add({
      ...values,
      createdAt: now,
      updatedAt: now,
    })
  }

  /** Replace an order: every field the client may send takes the value of the body. */
  async replaceOrder(key: number, values: OrderCreate): Promise<OrderRecord> {
    await this.find(key)
    await this.checkReferences(values)
    const now = new Date().toISOString()
    return this.repository.update(key, {
      ...values,
      updatedAt: now,
    })
  }

  /** Update part of an order: only the fields in the body change. */
  async updateOrder(key: number, values: OrderUpdate): Promise<OrderRecord> {
    await this.find(key)
    await this.checkReferences(values)
    const now = new Date().toISOString()
    return this.repository.update(key, {
      ...(values as Partial<OrderRecord>),
      updatedAt: now,
    })
  }

  /** Delete an order. */
  async deleteOrder(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
