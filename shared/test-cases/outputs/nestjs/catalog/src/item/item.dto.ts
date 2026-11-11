/**
 * Request and response shapes of items.
 */

import { IsEmail, IsInt, IsNumber, IsString, MaxLength, Min, MinLength, ValidateIf } from 'class-validator'

/** Body of a request that creates or replaces an item. */
export class CreateItemDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name!: string

  @IsNumber()
  @Min(0)
  price!: number

  @IsEmail()
  supplierEmail!: string

  @IsInt()
  categoryId!: number

  @IsInt()
  @Min(0)
  stock!: number
}

/** Body of a request that changes part of an item: only the fields sent change. */
export class UpdateItemDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(0)
  price?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsEmail()
  supplierEmail?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  categoryId?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  stock?: number
}

/** An item as the repositories keep it: what clients send and what the server fills. */
export type ItemRecord = CreateItemDto & {
  id: number
}

/** An item as the API returns it. */
export type Item = ItemRecord

/** The response of a stored item. */
export function toItem(record: ItemRecord): Item {
  return { ...record }
}
