/**
 * Sample values for the generated tests, as C# expressions: each one fits its column (type, length, precision,
 * the CHECK constraints the rules understand) and changes with `n`, an int of the generated factory, so rows made
 * with different numbers do not clash on unique columns. Mirrors java/samples.ts.
 */
import type { DbCheck, DbEnum } from '../../schema/types.ts'
import { csString } from './csharp.ts'
import type { ColumnInfo } from './context.ts'

function checksOf(column: ColumnInfo, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.column.name)
}

/** A whole number in the column's C# type. */
function whole(cs: string, text: string): string {
  const literal = /^-?\d+$/.test(text)
  if (cs === 'long') return literal ? `${text}L` : `(long)(${text})`
  if (cs === 'short') return `(short)(${text})`
  return literal ? text : `(${text})`
}

/** A whole number that changes with n and stays above the lower bound a CHECK sets. */
function number(column: ColumnInfo, checks: DbCheck[]): string {
  let low = 0
  for (const parsed of checksOf(column, checks))
    if (parsed?.kind === 'compare' && (parsed.op === '>' || parsed.op === '>=')) low = Math.max(low, Math.ceil(parsed.value))
  return low === 0 ? 'n' : `${low} + n`
}

/** A C# expression for a value of the column. */
export function sampleValue(column: ColumnInfo, checks: DbCheck[], enums: DbEnum[]): string {
  const type = column.column.type
  const cs = column.cs
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') {
    const first = String(choices.values[0])
    if (type.kind === 'integer') return whole(cs, first)
    if (type.kind === 'decimal') return `${first}m`
    if (type.kind === 'float') return cs === 'float' ? `${first}f` : first.includes('.') ? first : `${first}.0`
    return csString(first)
  }
  switch (type.kind) {
    case 'integer':
      return whole(cs, number(column, checks))
    case 'decimal': {
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return `0.${'5'.padStart(scale, '0')}m`
      const wholePart = `n % ${10 ** Math.min(integerDigits, 4)}`
      return scale > 0 ? `(${wholePart}) + 0.${'5'.padEnd(scale, '0')}m` : `(decimal)(${wholePart})`
    }
    case 'float':
      return cs === 'float' ? `${number(column, checks)} + 0.5f` : `${number(column, checks)} + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `(n % ${10 ** Math.min(length, 9)}).ToString().PadLeft(${length}, '0')`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `$"${prefix}-{n}"` : `(n % ${10 ** Math.min(length, 9)}).ToString()`
    }
    case 'enum':
      return csString(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
      return 'new DateOnly(2026, 1, n % 28 + 1)'
    case 'time':
      return cs === 'DateTimeOffset' ? 'new DateTimeOffset(1970, 1, 1, 12, n % 60, 0, TimeSpan.Zero)' : 'new TimeOnly(12, n % 60)'
    case 'datetime':
      return cs === 'DateTimeOffset'
        ? 'new DateTimeOffset(2026, 1, n % 28 + 1, 12, 0, 0, TimeSpan.Zero)'
        : 'new DateTime(2026, 1, n % 28 + 1, 12, 0, 0)'
    case 'uuid':
      return 'Guid.Parse($"00000000-0000-4000-8000-{n:D12}")'
    case 'binary':
      return 'new byte[] { (byte)n }'
    case 'json':
      return '$"{{\\"n\\": {n}}}"'
    case 'array':
      return '"[]"'
    case 'unknown':
      return '$"value-{n}"'
  }
}

/** A key no row has, as a C# expression, for the tests of missing rows. */
export function missingValue(column: ColumnInfo): string {
  switch (column.cs) {
    case 'long':
      return '999999L'
    case 'int':
      return '999999'
    case 'short':
      return '(short)9999'
    case 'decimal':
      return '999999m'
    case 'double':
      return '999999.0'
    case 'float':
      return '999999f'
    case 'Guid':
      return 'Guid.Parse("00000000-0000-4000-8000-000000999999")'
    case 'DateOnly':
      return 'new DateOnly(1999, 1, 1)'
    default:
      return '"missing"'
  }
}
