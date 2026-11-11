/**
 * Rules of customers: what each operation checks and changes.
 */

import { Inject, Injectable } from '@nestjs/common'
import { notFound } from '../common/errors'
import { type ListQuery, type ListResult } from '../common/listing'
import { type CreateCustomerDto, type CustomerRecord, type UpdateCustomerDto } from './customer.dto'
import { CUSTOMER_REPOSITORY, type CustomerRepository } from './customer.repository'

@Injectable()
export class CustomerService {
  constructor(@Inject(CUSTOMER_REPOSITORY) private readonly repository: CustomerRepository) {}

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
  async createCustomer(values: CreateCustomerDto): Promise<CustomerRecord> {
    const now = new Date().toISOString()
    return this.repository.add({
      ...values,
      createdAt: now,
    })
  }

  /** Replace a customer: every field the client may send takes the value of the body. */
  async replaceCustomer(key: number, values: CreateCustomerDto): Promise<CustomerRecord> {
    await this.find(key)
    return this.repository.update(key, values)
  }

  /** Update part of a customer: only the fields in the body change. */
  async updateCustomer(key: number, values: UpdateCustomerDto): Promise<CustomerRecord> {
    await this.find(key)
    return this.repository.update(key, values as Partial<CustomerRecord>)
  }

  /** Delete a customer. */
  async deleteCustomer(key: number): Promise<void> {
    await this.find(key)
    await this.repository.delete(key)
  }
}
