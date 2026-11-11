/**
 * Request and response shapes of categories.
 */

import { IsInt, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator'

/** Body of a request that creates or replaces a category. */
export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string

  @IsOptional()
  @IsInt()
  parentId?: number | null
}

/** Body of a request that changes part of a category: only the fields sent change. */
export class UpdateCategoryDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string

  @IsOptional()
  @IsInt()
  parentId?: number | null
}

/** A category as the repositories keep it: what clients send and what the server fills. */
export type CategoryRecord = CreateCategoryDto & {
  id: number
}

/** A category as the API returns it. */
export type Category = CategoryRecord

/** The response of a stored category. */
export function toCategory(record: CategoryRecord): Category {
  return { ...record }
}
