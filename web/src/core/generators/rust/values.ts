/** Rust expressions of values: the literal of a default, and the current time. */
import type { ColumnInfo } from './context.ts'
import { rsString } from './rust.ts'

/** A literal of a default, as a Rust expression of the column's type. */
export function rsLiteral(column: ColumnInfo, value: string | number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  const text = String(value)
  switch (column.rs) {
    case 'i64':
    case 'i32':
    case 'i16':
      return text
    case 'f64':
    case 'f32':
      return /[.eE]/.test(text) ? text : `${text}.0`
    case 'bool':
      return text
    case 'String':
      return `${rsString(text)}.to_string()`
    case 'Vec<u8>':
      return `${rsString(text)}.as_bytes().to_vec()`
    default:
      return `${rsString(text)}.parse::<${column.rs}>().expect(${rsString(`a ${column.rs}`)})`
  }
}

/** The current time, as a value of the column's type. */
export function nowOf(column: ColumnInfo): string | null {
  switch (column.rs) {
    case 'chrono::DateTime<chrono::FixedOffset>':
      return 'chrono::Utc::now().fixed_offset()'
    case 'chrono::NaiveDateTime':
      return 'chrono::Utc::now().naive_utc()'
    case 'chrono::NaiveDate':
      return 'chrono::Utc::now().date_naive()'
    case 'chrono::NaiveTime':
      return 'chrono::Utc::now().time()'
    default:
      return null
  }
}
