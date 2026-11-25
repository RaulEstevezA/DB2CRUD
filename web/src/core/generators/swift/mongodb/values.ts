/** Values between Swift and the documents of MongoDB, by the functions of `Bson.swift`. */
import { isObjectId } from '../../../schema/documents.ts'
import type { DbType } from '../../../schema/types.ts'
import type { NestedStruct } from '../documents.ts'

/** The name of a plain value in the functions: `asText` reads it, `ofText` writes it. */
function plainName(type: DbType): string {
  if (isObjectId(type)) return 'ObjectId'
  switch (type.kind) {
    case 'integer':
      return type.bits === 64 ? 'Int64' : 'Int32'
    case 'float':
      return type.bits === 32 ? 'Float' : 'Double'
    case 'decimal':
      return 'Decimal'
    case 'boolean':
      return 'Bool'
    case 'datetime':
      return 'Date'
    case 'uuid':
      return 'UUID'
    case 'binary':
      return 'Data'
    case 'json':
    case 'unknown':
      return 'Any'
    default:
      return 'Text'
  }
}

/** The function that reads a value: `Bson.asText`. */
export function reads(type: DbType, nested: NestedStruct | null): string {
  if (type.kind === 'array') return `Bson.asList(${reads(type.items, nested)})`
  if (type.kind === 'json' && type.fields && nested) return `Bson.asNested(${nested.path}.self)`
  return `Bson.as${plainName(type)}`
}

/** The function that writes a value: `Bson.ofText`. */
export function writes(type: DbType, nested: NestedStruct | null): string {
  if (type.kind === 'array') return `Bson.ofList(${writes(type.items, nested)})`
  if (type.kind === 'json' && type.fields && nested) return 'Bson.ofNested'
  return `Bson.of${plainName(type)}`
}

/** A value that is there, as a document holds it. */
export const encoded = (type: DbType, value: string, nested: NestedStruct | null = null) => `try ${writes(type, nested)}(${value})`
