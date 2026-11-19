/**
 * Sample values for the generated tests, as Swift expressions: each one fits its column (type, length, precision, the
 * CHECK constraints the rules understand) and changes with `n`, an Int of the generated factory, so rows made with
 * different numbers do not clash on unique columns. Mirrors kotlin/samples.ts.
 */
import type { DbCheck, DbEnum } from '../../schema/types.ts'
import type { ColumnInfo } from './context.ts'
import { swString } from './swift.ts'

function checksOf(column: ColumnInfo, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.column.name)
}

/** A whole number that changes with n and stays above the lower bound a CHECK sets. */
function whole(column: ColumnInfo, checks: DbCheck[]): string {
  let low = 0
  for (const parsed of checksOf(column, checks))
    if (parsed?.kind === 'compare' && (parsed.op === '>' || parsed.op === '>=')) low = Math.max(low, Math.ceil(parsed.value))
  return low === 0 ? 'n' : `${low} + n`
}

/** A literal of a value, in the column's Swift type. */
export function swLiteralOf(column: ColumnInfo, value: string | number): string {
  const text = String(value)
  if (column.sw === 'Int') return text
  if (column.sw === 'Double' || column.sw === 'Float') return /[.eE]/.test(text) ? text : `${text}.0`
  if (column.sw === 'Decimal') return `Decimal(string: ${swString(text)})!`
  return swString(text)
}

/** A day of 2026 that changes with n, at noon. */
const day = 'Date(timeIntervalSince1970: TimeInterval(1_767_268_800 + (n % 28) * 86_400))'

/** A Swift expression for a value of the column. */
export function sampleValue(column: ColumnInfo, checks: DbCheck[], enums: DbEnum[]): string {
  const type = column.column.type
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') return swLiteralOf(column, choices.values[0])
  switch (type.kind) {
    case 'integer':
      return whole(column, checks)
    case 'decimal': {
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return `Decimal(string: ${swString(`0.${'5'.padStart(scale, '0')}`)})!`
      const part = `n % ${10 ** Math.min(integerDigits, 4)}`
      return scale > 0 ? `Decimal(string: "\\(${part}).${'5'.padEnd(scale, '0')}")!` : `Decimal(${part})`
    }
    case 'float':
      return `${column.sw}(${whole(column, checks)}) + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `String(format: "%0${length}d", n % ${10 ** Math.min(length, 9)})`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `"${prefix}-\\(n)"` : `String(n % ${10 ** Math.min(length, 9)})`
    }
    case 'enum':
      return swString(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
    case 'datetime':
      return day
    case 'time':
      return 'TimeOfDay(hour: 12, minute: n % 60)'
    case 'uuid':
      return 'UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!'
    case 'binary':
      return 'Data([UInt8(n % 256)])'
    case 'json':
      return '"{\\"n\\": \\(n)}"'
    case 'array':
      return '"[]"'
    case 'unknown':
      return '"value-\\(n)"'
  }
}

/** A key no row has, as a Swift expression, for the tests of missing rows. */
export function missingValue(column: ColumnInfo): string {
  switch (column.sw) {
    case 'Int':
      return '999999'
    case 'Decimal':
      return 'Decimal(999999)'
    case 'Double':
    case 'Float':
      return '999999.0'
    case 'UUID':
      return 'UUID(uuidString: "00000000-0000-4000-8000-000000999999")!'
    case 'Date':
      return 'Date(timeIntervalSince1970: 0)'
    case 'TimeOfDay':
      return 'TimeOfDay(hour: 0, minute: 0, second: 1)'
    case 'Bool':
      return 'false'
    case 'Data':
      return 'Data([255, 255])'
    default:
      return '"missing"'
  }
}
