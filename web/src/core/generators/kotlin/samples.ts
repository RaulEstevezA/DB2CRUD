/**
 * Sample values for the generated tests, as Kotlin expressions: each one fits its column (type, length, precision,
 * the CHECK constraints the rules understand) and changes with `n`, an Int of the generated factory, so rows made with
 * different numbers do not clash on unique columns. Mirrors php/common/samples.ts.
 */
import type { DbCheck, DbEnum } from '../../schema/types.ts'
import { boundedNumber } from '../samples.ts'
import type { ColumnInfo } from './context.ts'
import { ktLiteral } from './repositories.ts'
import { type KtImports, ktString } from './kotlin.ts'

function checksOf(column: ColumnInfo, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.column.name)
}

/** A whole number that changes with n and stays within the bounds a CHECK sets, in the column's type. */
function whole(column: ColumnInfo, checks: DbCheck[]): string {
  const number = boundedNumber(checksOf(column, checks), 'n', column.column.type.kind === 'float')
  const value = number === 'n' ? number : `(${number})`
  if (column.kt === 'Long') return `${value}.toLong()`
  if (column.kt === 'Short') return `${value}.toShort()`
  return number
}

/** A Kotlin expression for a value of the column, adding its imports. */
export function sampleValue(column: ColumnInfo, checks: DbCheck[], enums: DbEnum[], imports: KtImports): string {
  const type = column.column.type
  if (column.ktImport) imports.add(column.ktImport)
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') {
    const first = choices.values[0]
    return typeof first === 'number' || ['integer', 'decimal', 'float'].includes(type.kind)
      ? ktLiteral(column, first)
      : ktString(String(first))
  }
  switch (type.kind) {
    case 'integer':
      return whole(column, checks)
    case 'decimal': {
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return `BigDecimal(${ktString(`0.${'5'.padStart(scale, '0')}`)})`
      const part = `n % ${10 ** Math.min(integerDigits, 4)}`
      return scale > 0 ? `BigDecimal("\${${part}}.${'5'.padEnd(scale, '0')}")` : `BigDecimal(${part})`
    }
    case 'float':
      return column.kt === 'Float'
        ? `${whole({ ...column, kt: 'Int' }, checks)} + 0.5f`
        : `${whole({ ...column, kt: 'Int' }, checks)} + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `(n % ${10 ** Math.min(length, 9)}).toString().padStart(${length}, '0')`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `"${prefix}-$n"` : `(n % ${10 ** Math.min(length, 9)}).toString()`
    }
    case 'enum':
      return ktString(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
      return 'LocalDate.of(2026, 1, n % 28 + 1)'
    case 'time':
      return 'LocalTime.of(12, n % 60)'
    case 'datetime':
      if (column.kt === 'OffsetDateTime') {
        imports.add('java.time.ZoneOffset')
        return 'OffsetDateTime.of(2026, 1, n % 28 + 1, 12, 0, 0, 0, ZoneOffset.UTC)'
      }
      if (column.kt === 'Instant') {
        imports.add('java.time.LocalDateTime', 'java.time.ZoneOffset')
        return 'LocalDateTime.of(2026, 1, n % 28 + 1, 12, 0).toInstant(ZoneOffset.UTC)'
      }
      return 'LocalDateTime.of(2026, 1, n % 28 + 1, 12, 0)'
    case 'uuid':
      return 'UUID.fromString("00000000-0000-4000-8000-%012d".format(n))'
    case 'binary':
      // As long as the column, when its length may be fixed: the database fills shorter values
      return type.length !== undefined && type.length <= 64 ? `ByteArray(${type.length}) { n.toByte() }` : 'byteArrayOf(n.toByte())'
    case 'json':
      return '"{\\"n\\": $n}"'
    case 'array':
      return '"[]"'
    case 'unknown':
      return '"value-$n"'
  }
}

/** A key no row has, as a Kotlin expression, for the tests of missing rows. */
export function missingValue(column: ColumnInfo, imports: KtImports): string {
  if (column.ktImport) imports.add(column.ktImport)
  switch (column.kt) {
    case 'Long':
      return '999999L'
    case 'Int':
      return '999999'
    case 'Short':
      return '9999.toShort()'
    case 'BigDecimal':
      return 'BigDecimal("999999")'
    case 'Double':
      return '999999.0'
    case 'Float':
      return '999999f'
    case 'UUID':
      return 'UUID.fromString("00000000-0000-4000-8000-000000999999")'
    case 'LocalDate':
      return 'LocalDate.of(1999, 1, 1)'
    case 'ByteArray':
      return 'byteArrayOf(-1, -1)'
    default:
      return '"missing"'
  }
}
