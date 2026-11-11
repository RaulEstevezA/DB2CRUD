/**
 * Request and response shapes of books.
 */

import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator'
import { GENRE, type Genre } from '../shared/shared.dto'

/** Body of a request that creates or replaces a book. */
export class CreateBookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string

  @IsString()
  @Matches(new RegExp('^[0-9]{13}$'))
  isbn!: string

  @IsUUID()
  authorId!: string

  @IsIn(GENRE)
  genre!: Genre

  @IsInt()
  @Min(1)
  @Max(5000)
  pages!: number

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  published: string | null = null

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  available: boolean = true
}

/** Body of a request that changes part of a book: only the fields sent change. */
export class UpdateBookDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(new RegExp('^[0-9]{13}$'))
  isbn?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  authorId?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(GENRE)
  genre?: Genre

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(5000)
  pages?: number

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  published?: string | null

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  available?: boolean
}

/** A book as the repositories keep it: what clients send and what the server fills. */
export type BookRecord = CreateBookDto & {
  id: string
}

/** A book as the API returns it. */
export type Book = BookRecord

/** The response of a stored book. */
export function toBook(record: BookRecord): Book {
  return { ...record }
}
