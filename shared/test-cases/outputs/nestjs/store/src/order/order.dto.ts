/**
 * Request and response shapes of orders.
 */

import { Type } from 'class-transformer'
import { IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, ValidateIf, ValidateNested } from 'class-validator'
import { ORDER_STATUS, OrderLineDto, type OrderStatus } from '../shared/shared.dto'

/** Body of a request that creates or replaces an order. */
export class CreateOrderDto {
  @IsInt()
  customerId!: number

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[]

  @IsIn(ORDER_STATUS)
  status!: OrderStatus

  @IsNumber()
  total!: number

  @IsOptional()
  @IsString()
  notes?: string | null
}

/** Body of a request that changes part of an order: only the fields sent change. */
export class UpdateOrderDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  customerId?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines?: OrderLineDto[]

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ORDER_STATUS)
  status?: OrderStatus

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  total?: number

  @IsOptional()
  @IsString()
  notes?: string | null
}

/** An order as the repositories keep it: what clients send and what the server fills. */
export type OrderRecord = CreateOrderDto & {
  id: number
  createdAt: string
  updatedAt: string
}

/** An order as the API returns it. */
export type Order = OrderRecord

/** The response of a stored order. */
export function toOrder(record: OrderRecord): Order {
  return { ...record }
}
