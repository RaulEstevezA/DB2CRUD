/**
 * Sample values for the generated tests, as Java expressions: each one fits its column (type, length,
 * precision, the CHECK constraints the rules understand) and changes with `n`, an int of the generated factory, so
 * rows made with different numbers do not clash on unique columns. Mirrors typescript/samples.ts.
 */
import type { DbCheck, DbEnum } from '../../schema/types.ts'
import { javaString } from './java.ts'
import type { ColumnInfo } from './context.ts'

function checksOf(column: ColumnInfo, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.column.name)
}

/** A whole-number literal in the column's Java type. */
function whole(java: string, text: string): string {
  if (java === 'Long') return /^-?\d+$/.test(text) ? `${text}L` : `(long) (${text})`
  if (java === 'Short') return `(short) (${text})`
  if (java === 'Integer') return /^-?\d+$/.test(text) ? text : `(${text})`
  return text
}

/** A whole number that changes with n and stays above the lower bound a CHECK sets. */
function number(column: ColumnInfo, checks: DbCheck[]): string {
  let low = 0
  for (const parsed of checksOf(column, checks))
    if (parsed?.kind === 'compare' && (parsed.op === '>' || parsed.op === '>=')) low = Math.max(low, Math.ceil(parsed.value))
  return low === 0 ? 'n' : `${low} + n`
}

/** The imports the samples of a column need. */
export function sampleImports(column: ColumnInfo): string[] {
  const result: string[] = []
  if (column.javaImport) result.push(column.javaImport)
  if (column.java === 'OffsetDateTime' || column.java === 'OffsetTime') result.push('java.time.ZoneOffset')
  return result
}

/** A Java expression for a value of the column. */
export function sampleValue(column: ColumnInfo, checks: DbCheck[], enums: DbEnum[]): string {
  const type = column.column.type
  const java = column.java
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') {
    const first = String(choices.values[0])
    if (type.kind === 'integer') return whole(java, first)
    if (type.kind === 'decimal') return `new BigDecimal(${javaString(first)})`
    if (type.kind === 'float') return java === 'Float' ? `${first}f` : first.includes('.') ? first : `${first}.0`
    return javaString(first)
  }
  switch (type.kind) {
    case 'integer':
      return whole(java, number(column, checks))
    case 'decimal': {
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return `new BigDecimal("0.${'5'.padStart(scale, '0')}")`
      const wholePart = `n % ${10 ** Math.min(integerDigits, 4)}`
      return scale > 0 ? `new BigDecimal((${wholePart}) + ".${'5'.padEnd(scale, '0')}")` : `new BigDecimal(String.valueOf(${wholePart}))`
    }
    case 'float':
      return java === 'Float' ? `${number(column, checks)} + 0.5f` : `${number(column, checks)} + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `String.format("%0${length}d", n % ${10 ** Math.min(length, 9)})`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `"${prefix}-" + n` : `String.valueOf(n % ${10 ** Math.min(length, 9)})`
    }
    case 'enum':
      return javaString(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
      return 'LocalDate.of(2026, 1, n % 28 + 1)'
    case 'time':
      return java === 'OffsetTime' ? 'OffsetTime.of(12, n % 60, 0, 0, ZoneOffset.UTC)' : 'LocalTime.of(12, n % 60)'
    case 'datetime':
      return java === 'OffsetDateTime'
        ? 'OffsetDateTime.of(2026, 1, n % 28 + 1, 12, 0, 0, 0, ZoneOffset.UTC)'
        : 'LocalDateTime.of(2026, 1, n % 28 + 1, 12, 0)'
    case 'uuid':
      return 'UUID.fromString(String.format("00000000-0000-4000-8000-%012d", n))'
    case 'binary':
      return 'new byte[] { (byte) n }'
    case 'json':
      return '"{\\"n\\": " + n + "}"'
    case 'array':
      return '"[]"'
    case 'unknown':
      return '"value-" + n'
  }
}

/** A key no row has, as a Java expression, for the tests of missing rows. */
export function missingValue(column: ColumnInfo): string {
  switch (column.java) {
    case 'Long':
      return '999999L'
    case 'Integer':
      return '999999'
    case 'Short':
      return '(short) 9999'
    case 'BigDecimal':
      return 'new BigDecimal("999999")'
    case 'Double':
      return '999999.0'
    case 'Float':
      return '999999f'
    case 'UUID':
      return 'UUID.fromString("00000000-0000-4000-8000-000000999999")'
    case 'LocalDate':
      return 'LocalDate.of(1999, 1, 1)'
    default:
      return '"missing"'
  }
}
