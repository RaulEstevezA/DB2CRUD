/**
 * Rules of customers: what each operation checks and changes.
 */

import { notFound } from '../errors.js'
import { type ListQuery, type ListResult } from '../listing.js'
import { type CustomerRepository } from '../repositories/customer.js'
import { type CustomerCreate, type CustomerRecord, type CustomerUpdate } from '../schemas/customer.js'

export class CustomerService {
  constructor(private readonly repository: CustomerRepository) {}

  private async find(key: number): Promise<CustomerRecord> {
    const item = await this.repository.get(key)
    if (item === undefined) throw notFound('customer')
    return item
  }

  /** List customers. */
  listCustomers(query: ListQuery): Promise<ListResult<CustomerRecord>> {
    return this.repository.list(query)
  }

  /** Get a customer. */
  getCustomer(key: number): Promise<CustomerRecord> {
    return this.find(key)
  }

  /** Create a customer. */
  async createCustomer(values: CustomerCreate): Promise<CustomerRecord> {
    const now = new Date().toISOString()
    return this.repository.add({
      ...values,
      createdAt: now,
    })
  }

  /** Replace a customer: every field the client may send takes the value of the body. */
  async replaceCustomer(key: number, values: CustomerCreate): Promise<CustomerRecord> {
    await this.find(key)
    return this.repository.update(key, values)
  }

  /** Update part of a customer: only the fields in the body change. */
  async updateCustomer(key: number, values: CustomerUpdate): Promise<CustomerRecord> {
    await this.find(key)
    return this.repository.update(key, values as Partial<CustomerRecord>)
  }

  /** Delete a customer. */
  async deleteCustomer(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
