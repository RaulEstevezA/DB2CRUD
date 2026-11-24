/**
 * Sample values for the generated tests, as Rust expressions: each one fits its column (type, length, precision, the
 * CHECK constraints the rules understand) and changes with `n`, an i32 of the generated factory, so rows made with
 * different numbers do not clash on unique columns. Mirrors kotlin/samples.ts.
 */
import type { DbCheck, DbEnum } from '../../schema/types.ts'
import type { ColumnInfo } from './context.ts'
import { rsLiteral } from './values.ts'
import { owned } from './rust.ts'

function checksOf(column: ColumnInfo, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.column.name)
}

/** A whole number that changes with n and stays above the lower bound a CHECK sets, in the column's type. */
function whole(column: ColumnInfo, checks: DbCheck[]): string {
  let low = 0
  for (const parsed of checksOf(column, checks))
    if (parsed?.kind === 'compare' && (parsed.op === '>' || parsed.op === '>=')) low = Math.max(low, Math.ceil(parsed.value))
  const value = low === 0 ? 'n' : `${low} + n`
  if (column.rs === 'i64') return `i64::from(${value})`
  if (column.rs === 'i16') return `(${value}) as i16`
  return value
}

const date = 'chrono::NaiveDate::from_ymd_opt(2026, 1, (n % 28 + 1) as u32).expect("a date")'

/** A Rust expression for a value of the column. */
export function sampleValue(column: ColumnInfo, checks: DbCheck[], enums: DbEnum[]): string {
  const type = column.column.type
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') {
    const first = choices.values[0]
    return typeof first === 'number' || ['integer', 'decimal', 'float'].includes(type.kind)
      ? rsLiteral(column, first)
      : owned(String(first))
  }
  switch (type.kind) {
    case 'integer':
      return whole(column, checks)
    case 'decimal': {
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return `rust_decimal::Decimal::new(5, ${scale})`
      const part = `i64::from(n % ${10 ** Math.min(integerDigits, 4)})`
      return scale > 0
        ? `rust_decimal::Decimal::new(${part} * ${10 ** scale} + ${5 * 10 ** (scale - 1)}, ${scale})`
        : `rust_decimal::Decimal::from(${part})`
    }
    case 'float':
      return column.rs === 'f32'
        ? `(${whole({ ...column, rs: 'i32' }, checks)}) as f32 + 0.5`
        : `f64::from(${whole({ ...column, rs: 'i32' }, checks)}) + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `format!("{:0>${length}}", n % ${10 ** Math.min(length, 9)})`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `format!("${prefix}-{n}")` : `(n % ${10 ** Math.min(length, 9)}).to_string()`
    }
    case 'enum':
      return owned(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
      return date
    case 'time':
      return 'chrono::NaiveTime::from_hms_opt(12, (n % 60) as u32, 0).expect("a time")'
    case 'datetime':
      return column.rs === 'chrono::NaiveDateTime'
        ? `${date}.and_hms_opt(12, 0, 0).expect("a time")`
        : `${date}.and_hms_opt(12, 0, 0).expect("a time").and_utc().fixed_offset()`
    case 'uuid':
      return 'uuid::Uuid::from_u128(n as u128)'
    case 'binary':
      // As long as the column, when its length may be fixed: the database fills shorter values
      return type.length !== undefined && type.length <= 64 ? `vec![n as u8; ${type.length}]` : 'vec![n as u8]'
    case 'json':
      return 'format!("{{\\"n\\": {n}}}")'
    case 'array':
      return '"[]".to_string()'
    case 'unknown':
      return 'format!("value-{n}")'
  }
}

/** A key no row has, as a Rust expression, for the tests of missing rows. */
export function missingValue(column: ColumnInfo): string {
  switch (column.rs) {
    case 'i64':
    case 'i32':
      return '999999'
    case 'i16':
      return '9999'
    case 'rust_decimal::Decimal':
      return 'rust_decimal::Decimal::from(999999)'
    case 'f64':
    case 'f32':
      return '999999.0'
    case 'uuid::Uuid':
      return 'uuid::Uuid::from_u128(999999)'
    case 'chrono::NaiveDate':
      return 'chrono::NaiveDate::from_ymd_opt(1999, 1, 1).expect("a date")'
    case 'chrono::NaiveDateTime':
      return 'chrono::NaiveDate::from_ymd_opt(1999, 1, 1).expect("a date").and_hms_opt(0, 0, 0).expect("a time")'
    case 'chrono::DateTime<chrono::FixedOffset>':
      return 'chrono::NaiveDate::from_ymd_opt(1999, 1, 1).expect("a date").and_hms_opt(0, 0, 0).expect("a time").and_utc().fixed_offset()'
    case 'chrono::NaiveTime':
      return 'chrono::NaiveTime::from_hms_opt(0, 0, 1).expect("a time")'
    case 'bool':
      return 'false'
    case 'Vec<u8>':
      return 'vec![255, 255]'
    default:
      return '"missing".to_string()'
  }
}
