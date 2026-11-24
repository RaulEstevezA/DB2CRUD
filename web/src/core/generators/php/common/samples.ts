/**
 * Sample values for the generated tests, as PHP expressions: each one fits its column (type, length, precision,
 * the CHECK constraints the rules understand) and changes with `$n`, an int of the generated factory, so rows made
 * with different numbers do not clash on unique columns. Mirrors csharp/samples.ts.
 */
import type { DbCheck, DbEnum } from '../../../schema/types.ts'
import { boundedNumber } from '../../samples.ts'
import type { ColumnInfo } from './context.ts'
import { phpString } from './php.ts'

function checksOf(column: ColumnInfo, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.column.name)
}

/** A whole number that changes with $n and stays within the bounds a CHECK sets. */
function number(column: ColumnInfo, checks: DbCheck[]): string {
  return boundedNumber(checksOf(column, checks), '$n', column.column.type.kind === 'float')
}

const DATE_TIME = '\\DateTimeImmutable'

/** A PHP expression for a value of the column. */
export function sampleValue(column: ColumnInfo, checks: DbCheck[], enums: DbEnum[]): string {
  const type = column.column.type
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') {
    const first = String(choices.values[0])
    if (type.kind === 'integer') return first
    if (type.kind === 'float') return /[.eE]/.test(first) ? first : `${first}.0`
    return phpString(first)
  }
  switch (type.kind) {
    case 'integer':
      return number(column, checks)
    case 'decimal': {
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return phpString(`0.${'5'.padStart(scale, '0')}`)
      const wholePart = `$n % ${10 ** Math.min(integerDigits, 4)}`
      return scale > 0 ? `(${wholePart}) . ${phpString(`.${'5'.padEnd(scale, '0')}`)}` : `(string) (${wholePart})`
    }
    case 'float':
      return `${number(column, checks)} + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `str_pad((string) ($n % ${10 ** Math.min(length, 9)}), ${length}, '0', STR_PAD_LEFT)`
      // The column name and the number, as long as it fits; $n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `"${prefix}-{$n}"` : `(string) ($n % ${10 ** Math.min(length, 9)})`
    }
    case 'enum':
      return phpString(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
      if (column.php === 'string') return "sprintf('2026-01-%02d', $n % 28 + 1)"
      return `new ${DATE_TIME}(sprintf('2026-01-%02d', $n % 28 + 1))`
    case 'time':
      return column.php === DATE_TIME ? `new ${DATE_TIME}(sprintf('12:%02d:00', $n % 60))` : "sprintf('12:%02d:00', $n % 60)"
    case 'datetime':
      if (column.php === 'string') return "sprintf('2026-01-%02d 12:00:00', $n % 28 + 1)"
      return `new ${DATE_TIME}(sprintf('2026-01-%02d 12:00:00', $n % 28 + 1))`
    case 'uuid':
      return "sprintf('00000000-0000-4000-8000-%012d', $n)"
    case 'binary':
      // As long as the column, when its length may be fixed: the database fills shorter values
      return type.length !== undefined && type.length <= 64 ? `str_repeat(chr($n % 256), ${type.length})` : 'chr($n % 256)'
    case 'json':
      return "['n' => $n]"
    case 'array':
      return '[]'
    case 'unknown':
      return '"value-{$n}"'
  }
}

/** A key no row has, as a PHP expression, for the tests of missing rows. */
export function missingValue(column: ColumnInfo): string {
  switch (column.php) {
    case 'int':
      return '999999'
    case 'float':
      return '999999.0'
    case DATE_TIME:
      return `new ${DATE_TIME}('1999-01-01')`
    default:
      return column.column.type.kind === 'uuid'
        ? "'00000000-0000-4000-8000-000000999999'"
        : column.column.type.kind === 'date'
          ? "'1999-01-01'"
          : column.column.type.kind === 'decimal'
            ? "'999999'"
            : "'missing'"
  }
}
