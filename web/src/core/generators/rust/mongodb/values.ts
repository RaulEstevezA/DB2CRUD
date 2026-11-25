/** Values between Rust and the documents of MongoDB, by the functions of `bson_values.rs`. */
import { isObjectId } from '../../../schema/documents.ts'
import type { DbType } from '../../../schema/types.ts'
import type { NestedStruct } from '../documents.ts'

/** The name of a plain value in the functions: `as_text` reads it, `of_text` writes it. */
function plainName(type: DbType): string {
  if (isObjectId(type)) return 'object_id'
  switch (type.kind) {
    case 'integer':
      return type.bits === 16 ? 'i16' : type.bits === 64 ? 'i64' : 'i32'
    case 'float':
      return type.bits === 32 ? 'f32' : 'f64'
    case 'decimal':
      return 'decimal'
    case 'boolean':
      return 'bool'
    case 'datetime':
      return 'moment'
    case 'uuid':
      return 'uuid'
    case 'binary':
      return 'bytes'
    case 'json':
    case 'unknown':
      return 'any'
    default:
      return 'text'
  }
}

/** The function that reads a value: `bson_values::as_text`. */
export function reads(type: DbType, nested: NestedStruct | null): string {
  if (type.kind === 'array') return `bson_values::as_list(${reads(type.items, nested)})`
  if (type.kind === 'json' && type.fields && nested) return `bson_values::as_nested(${nested.path}::from_document)`
  return `bson_values::as_${plainName(type)}`
}

/** The function that writes a value: `bson_values::of_text`. */
export function writes(type: DbType, nested: NestedStruct | null): string {
  if (type.kind === 'array') return `bson_values::of_list(${writes(type.items, nested)})`
  if (type.kind === 'json' && type.fields && nested) return `bson_values::of_nested(${nested.path}::to_document)`
  return `bson_values::of_${plainName(type)}`
}

/** A value that is there, as a document holds it. */
export const encoded = (type: DbType, value: string, nested: NestedStruct | null = null) => `${writes(type, nested)}(&${value})?`

const READERS: Record<string, { crate?: string; rs: string; read: string; write: string }> = {
  object_id: {
    rs: 'String',
    read: 'value.as_object_id().map(|id| id.to_hex())',
    write: 'ObjectId::parse_str(value).map(Bson::ObjectId).map_err(Error::custom)',
  },
  text: { rs: 'String', read: 'value.as_str().map(str::to_string)', write: 'Ok(Bson::String(value.clone()))' },
  bool: { rs: 'bool', read: 'value.as_bool()', write: 'Ok(Bson::Boolean(*value))' },
  i16: { rs: 'i16', read: 'whole(value).and_then(|number| number.try_into().ok())', write: 'Ok(Bson::Int32(i32::from(*value)))' },
  i32: { rs: 'i32', read: 'whole(value).and_then(|number| number.try_into().ok())', write: 'Ok(Bson::Int32(*value))' },
  i64: { rs: 'i64', read: 'whole(value)', write: 'Ok(Bson::Int64(*value))' },
  f32: { rs: 'f32', read: 'number(value).map(|number| number as f32)', write: 'Ok(Bson::Double(f64::from(*value)))' },
  f64: { rs: 'f64', read: 'number(value)', write: 'Ok(Bson::Double(*value))' },
  decimal: {
    crate: 'rust_decimal',
    rs: 'rust_decimal::Decimal',
    read: 'decimal(value)',
    write: 'value.to_string().parse().map(Bson::Decimal128).map_err(Error::custom)',
  },
  moment: {
    crate: 'chrono',
    rs: 'chrono::DateTime<chrono::Utc>',
    read: 'value.as_datetime().and_then(|moment| chrono::DateTime::from_timestamp_millis(moment.timestamp_millis()))',
    write: 'Ok(Bson::DateTime(DateTime::from_millis(value.timestamp_millis())))',
  },
  uuid: {
    crate: 'uuid',
    rs: 'uuid::Uuid',
    read: 'binary(value).and_then(|bytes| uuid::Uuid::from_slice(bytes).ok())',
    write: 'Ok(Bson::Binary(Binary { subtype: BinarySubtype::Uuid, bytes: value.as_bytes().to_vec() }))',
  },
  bytes: {
    rs: 'Vec<u8>',
    read: 'binary(value).cloned()',
    write: 'Ok(Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: value.clone() }))',
  },
  any: { rs: 'Bson', read: 'Some(value.clone())', write: 'Ok(value.clone())' },
}

/** The functions that read and write the values of the types in use. */
export function valueFunctions(crates: Set<string>): string[] {
  return Object.entries(READERS).flatMap(([name, item]) =>
    item.crate && !crates.has(item.crate)
      ? []
      : [
          '',
          `pub fn as_${name}(value: &Bson) -> Result<${item.rs}, Error> {`,
          `    ${item.read}.ok_or_else(|| unexpected(value))`,
          '}',
          '',
          `pub fn of_${name}(value: &${item.rs}) -> Result<Bson, Error> {`,
          `    ${item.write}`,
          '}',
        ],
  )
}
