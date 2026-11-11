/**
 * Request and response shapes of authors.
 */

import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator'

/** Body of a request that creates or replaces an author. */
export class CreateAuthorDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string

  @IsOptional()
  @IsEmail()
  email: string | null = null

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  born: string | null = null
}

/** Body of a request that changes part of an author: only the fields sent change. */
export class UpdateAuthorDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string

  @IsOptional()
  @IsEmail()
  email?: string | null

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  born?: string | null
}

/** An author as the repositories keep it: what clients send and what the server fills. */
export type AuthorRecord = CreateAuthorDto & {
  id: string
}

/** An author as the API returns it. */
export type Author = AuthorRecord

/** The response of a stored author. */
export function toAuthor(record: AuthorRecord): Author {
  return { ...record }
}
