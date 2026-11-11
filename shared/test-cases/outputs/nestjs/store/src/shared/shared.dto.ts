/**
 * Enums and embedded objects shared by the resources.
 */

import { IsInt, IsNumber, IsString } from 'class-validator'

/** Values of OrderStatus. */
export const ORDER_STATUS = ['pending', 'paid', 'shipped', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUS)[number]

/** Address, embedded in the resources that hold it. */
export class AddressDto {
  @IsString()
  street!: string

  @IsString()
  city!: string

  @IsString()
  postalCode!: string

  @IsString()
  country!: string
}

/** OrderLine, embedded in the resources that hold it. */
export class OrderLineDto {
  @IsInt()
  productId!: number

  @IsNumber()
  quantity!: number

  @IsNumber()
  unitPrice!: number
}
