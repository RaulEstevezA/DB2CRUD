/**
 * Request and response shapes of customers.
 */

import { Type } from 'class-transformer'
import { IsObject, IsString, ValidateIf, ValidateNested } from 'class-validator'
import { AddressDto } from '../shared/shared.dto'

/** Body of a request that creates or replaces a customer. */
export class CreateCustomerDto {
  @IsString()
  name!: string

  @IsString()
  email!: string

  @IsString()
  password!: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  phone?: string

  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto
}

/** Body of a request that changes part of a customer: only the fields sent change. */
export class UpdateCustomerDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  name?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  email?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  password?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  phone?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto
}

/** A customer as the repositories keep it: what clients send and what the server fills. */
export type CustomerRecord = CreateCustomerDto & {
  id: number
  createdAt: string
}

/** A customer as the API returns it. */
export type Customer = Omit<CustomerRecord, 'password'>

/** The response of a stored customer. */
export function toCustomer(record: CustomerRecord): Customer {
  const { password: _hidden0, ...response } = record
  return response
}
