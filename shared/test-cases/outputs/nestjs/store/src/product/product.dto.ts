/**
 * Request and response shapes of products.
 */

import { IsBoolean, IsNumber, IsString, ValidateIf } from 'class-validator'

/** Body of a request that creates or replaces a product. */
export class CreateProductDto {
  @IsString()
  sku!: string

  @IsString()
  name!: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  description?: string

  @IsNumber()
  price!: number

  @IsNumber()
  stock!: number

  @IsBoolean()
  active!: boolean
}

/** Body of a request that changes part of a product: only the fields sent change. */
export class UpdateProductDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  sku?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  name?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  description?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  price?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  stock?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  active?: boolean
}

/** A product as the repositories keep it: what clients send and what the server fills. */
export type ProductRecord = CreateProductDto & {
  id: number
}

/** A product as the API returns it. */
export type Product = ProductRecord

/** The response of a stored product. */
export function toProduct(record: ProductRecord): Product {
  return { ...record }
}
