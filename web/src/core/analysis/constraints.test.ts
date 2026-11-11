/**
 * Tests of the validations read from each notation, through the real importers.
 */
import { describe, expect, it } from 'vitest'
import { findModel } from '../model/schema.ts'
import { parseInput } from '../importers/registry.ts'
import type { InputFormatId } from '../importers/types.ts'
import { readConstraints, type Constraints } from './constraints.ts'

/** Constraints of every field of a model read from `text`. */
function constraintsOf(format: InputFormatId, text: string, model: string): Record<string, Constraints> {
  const outcome = parseInput(text, format)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return Object.fromEntries(findModel(outcome.schema, model)!.fields.map((field) => [field.name, readConstraints(field).constraints]))
}

describe('readConstraints', () => {
  it('reads Jakarta Bean Validation in Java', () => {
    const fields = constraintsOf(
      'java',
      `public class Product {
        @NotBlank @Size(min = 3, max = 80) private String name;
        @Email private String contact;
        @Min(0) @DecimalMax("9999.99") private BigDecimal price;
        @DecimalMin(value = "0", inclusive = false) private BigDecimal weight;
        @Pattern(regexp = "^[A-Z]{3}$") private String code;
        @Size(max = 5) private List<String> tags;
        @Positive private int stock;
      }`,
      'Product',
    )
    expect(fields.name).toEqual({ minLength: 3, maxLength: 80 })
    expect(fields.contact).toEqual({ format: 'email' })
    expect(fields.price).toEqual({ minimum: 0, maximum: 9999.99 })
    expect(fields.weight).toEqual({ exclusiveMinimum: 0 })
    expect(fields.code).toEqual({ pattern: '^[A-Z]{3}$' })
    expect(fields.tags).toEqual({ maxItems: 5 })
    expect(fields.stock).toEqual({ exclusiveMinimum: 0 })
  })

  it('reads Kotlin annotations with a use-site target', () => {
    const fields = constraintsOf(
      'kotlin',
      'data class Item(@field:Size(max = 20) val name: String, @field:Positive val qty: Int = 1)',
      'Item',
    )
    expect(fields.name).toEqual({ maxLength: 20 })
    expect(fields.qty).toEqual({ exclusiveMinimum: 0 })
  })

  it('reads Pydantic fields and types', () => {
    const fields = constraintsOf(
      'python',
      `from pydantic import BaseModel, Field, EmailStr, HttpUrl
from typing import Optional
class User(BaseModel):
    email: EmailStr
    site: HttpUrl
    name: str = Field(..., min_length=2, max_length=50, pattern=r"^[a-z ]+$")
    age: Optional[int] = Field(None, ge=0, lt=130)
`,
      'User',
    )
    expect(fields.email).toEqual({ format: 'email' })
    expect(fields.site).toEqual({ format: 'uri' })
    expect(fields.name).toEqual({ minLength: 2, maxLength: 50, pattern: '^[a-z ]+$' })
    expect(fields.age).toEqual({ minimum: 0, exclusiveMaximum: 130 })
  })

  it('reads Django and SQLAlchemy columns', () => {
    const django = constraintsOf(
      'python',
      `from django.db import models
class Article(models.Model):
    title = models.CharField(max_length=120)
    email = models.EmailField(unique=True)
`,
      'Article',
    )
    expect(django.title).toEqual({ maxLength: 120 })
    expect(django.email).toEqual({ format: 'email' })
    const alchemy = constraintsOf(
      'python',
      `from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
`,
      'User',
    )
    expect(alchemy.name).toEqual({ maxLength: 80 })
  })

  it('reads class-validator and TypeORM decorators', () => {
    const fields = constraintsOf(
      'typescript',
      `export class CreateUserDto {
        @IsEmail() email: string;
        @Length(2, 50) name: string;
        @IsOptional() @Min(0) @Max(120) age?: number;
        @Column({ length: 30 }) nick: string;
        @Matches(/^[a-z]+$/i) slug: string;
      }`,
      'CreateUserDto',
    )
    expect(fields.email).toEqual({ format: 'email' })
    expect(fields.name).toEqual({ minLength: 2, maxLength: 50 })
    expect(fields.age).toEqual({ minimum: 0, maximum: 120 })
    expect(fields.nick).toEqual({ maxLength: 30 })
    expect(fields.slug).toEqual({ pattern: '^[a-z]+$' })
  })

  it('reads C# DataAnnotations', () => {
    const fields = constraintsOf(
      'csharp',
      `public class Order {
        [StringLength(100, MinimumLength = 2)] public string Title { get; set; }
        [Range(1, 10)] public int Qty { get; set; }
        [EmailAddress] public string Mail { get; set; }
        [MaxLength(3)] public List<string> Codes { get; set; }
      }`,
      'Order',
    )
    expect(fields.Title).toEqual({ minLength: 2, maxLength: 100 })
    expect(fields.Qty).toEqual({ minimum: 1, maximum: 10 })
    expect(fields.Mail).toEqual({ format: 'email' })
    expect(fields.Codes).toEqual({ maxItems: 3 })
  })

  it('reads Zod checks by the type they apply to', () => {
    const fields = constraintsOf(
      'typescript',
      "import { z } from 'zod'\nexport const User = z.object({ email: z.string().email(), name: z.string().min(2).max(40), age: z.number().int().min(0), tags: z.array(z.string()).min(1) })",
      'User',
    )
    expect(fields.email).toEqual({ format: 'email' })
    expect(fields.name).toEqual({ minLength: 2, maxLength: 40 })
    expect(fields.age).toEqual({ minimum: 0 })
    expect(fields.tags).toEqual({ minItems: 1 })
  })

  it('reads Go validate tags by the type they apply to', () => {
    const fields = constraintsOf(
      'go',
      'type User struct { Name string `json:"name" validate:"required,min=2,max=50"`; Email string `validate:"email"`; Age int `validate:"gte=0,lte=130"` }',
      'User',
    )
    expect(fields.Name).toEqual({ minLength: 2, maxLength: 50 })
    expect(fields.Email).toEqual({ format: 'email' })
    expect(fields.Age).toEqual({ minimum: 0, maximum: 130 })
  })

  it('reads Prisma native sizes', () => {
    const fields = constraintsOf('prisma', 'model User {\n  id Int @id\n  name String @db.VarChar(80)\n}\n', 'User')
    expect(fields.name).toEqual({ maxLength: 80 })
  })

  it('reads JSON Schema keywords', () => {
    const fields = constraintsOf(
      'jsonschema',
      JSON.stringify({
        title: 'Pet',
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, format: 'email' }, age: { type: 'integer', minimum: 0 } },
      }),
      'Pet',
    )
    expect(fields.name).toEqual({ minLength: 1, format: 'email' })
    expect(fields.age).toEqual({ minimum: 0 })
  })

  it('keeps the stricter bound when several declarations apply', () => {
    const fields = constraintsOf(
      'java',
      'public class A { @NotBlank @Size(max = 40) @Length(min = 2, max = 30) private String name; }',
      'A',
    )
    expect(fields.name).toEqual({ minLength: 2, maxLength: 30 })
  })

  it('reads Symfony Validator in PHP', () => {
    const fields = constraintsOf(
      'php',
      `<?php
      use Symfony\\Component\\Validator\\Constraints as Assert;
      class Venue {
        #[Assert\\NotBlank] #[Assert\\Length(min: 3, max: 120)] private string $name;
        #[Assert\\Length(exactly: 5)] private string $postalCode;
        #[Assert\\Range(min: 1, max: 5000)] private int $capacity;
        #[Assert\\GreaterThan(0)] #[Assert\\LessThanOrEqual(value: 999.99)] private float $price;
        #[Assert\\Regex(pattern: '/^[A-Z]{2}\\d+$/')] private string $code;
        #[Assert\\Regex(pattern: '/\\d/', match: false)] private string $nickname;
        /** @var string[] */
        #[Assert\\Count(min: 1, max: 3)] private array $tags;
        #[Assert\\Email] private string $contact;
        #[Assert\\Uuid] private string $reference;
      }`,
      'Venue',
    )
    expect(fields.name).toEqual({ minLength: 3, maxLength: 120 })
    expect(fields.postalCode).toEqual({ minLength: 5, maxLength: 5 })
    expect(fields.capacity).toEqual({ minimum: 1, maximum: 5000 })
    expect(fields.price).toEqual({ exclusiveMinimum: 0, maximum: 999.99 })
    expect(fields.code).toEqual({ pattern: '^[A-Z]{2}\\d+$' })
    expect(fields.nickname).toEqual({})
    expect(fields.tags).toEqual({ minItems: 1, maxItems: 3 })
    expect(fields.contact).toEqual({ format: 'email' })
    expect(fields.reference).toEqual({ format: 'uuid' })
  })

  it('reads Laravel Data attributes and rules, which bound whatever the type has', () => {
    const outcome = parseInput(
      `<?php
      class Review extends Data {
        public function __construct(
          #[Max(255), Min(3)] public string $title,
          #[Between(1, 5)] public int $stars,
          #[Size(2)] public string $country,
          /** @var string[] */
          #[Max(3)] public array $tags,
          #[Rule('required|string|max:120')] public string $author,
          #[Rule(['required', 'email'])] public string $email,
          #[Rule('numeric|gte:0|lt:other')] public float $score,
          #[Regex('#^[a-z-]+$#')] public string $slug,
        ) {}
      }`,
      'php',
    )
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
    const read = (name: string) =>
      readConstraints(
        outcome.schema.models[0].fields.find((field) => field.name === name)!,
        outcome.schema.origin?.language,
      ).constraints
    expect(read('title')).toEqual({ minLength: 3, maxLength: 255 })
    expect(read('stars')).toEqual({ minimum: 1, maximum: 5 })
    expect(read('country')).toEqual({ minLength: 2, maxLength: 2 })
    expect(read('tags')).toEqual({ maxItems: 3 })
    expect(read('author')).toEqual({ maxLength: 120 })
    expect(read('email')).toEqual({ format: 'email' })
    // gt, gte, lt and lte against another field are not numbers and are left out
    expect(read('score')).toEqual({ minimum: 0 })
    expect(read('slug')).toEqual({ pattern: '^[a-z-]+$' })
  })

  it('ignores declarations that do not apply to the type', () => {
    const fields = constraintsOf('java', 'public class A { @Size(max = 4) private int count; @Min(1) private String code; }', 'A')
    expect(fields.count).toEqual({})
    expect(fields.code).toEqual({})
  })

  it('names the declarations each validation comes from', () => {
    const outcome = parseInput(
      'public class A { @NotBlank @Size(min = 3, max = 80) private String name; @Deprecated private String old; }',
      'java',
    )
    if (!outcome.ok) throw new Error('parse')
    const [name, old] = outcome.schema.models[0].fields
    expect(readConstraints(name).sources).toEqual(['NotBlank()', 'Size(min = 3, max = 80)'])
    expect(readConstraints(old).sources).toEqual([])
  })
})
