/**
 * Sample values for the generated tests, as Python expressions: each one fits its column (type, length,
 * precision, the CHECK constraints the rules understand) and changes with `n`, a variable of the generated
 * factory, so rows made with different numbers do not clash on unique columns.
 */
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'
import type { Imports } from './python.ts'

/** The constraint a CHECK puts on a column, when the rules understand it. */
function checksOf(column: DbColumn, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.name)
}

/** A whole number that changes with n and stays above the lower bound a CHECK sets. */
function number(column: DbColumn, checks: DbCheck[]): string {
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') return JSON.stringify(choices.values[0])
  let low = 0
  for (const parsed of checksOf(column, checks))
    if (parsed?.kind === 'compare' && (parsed.op === '>' || parsed.op === '>=')) low = Math.max(low, Math.ceil(parsed.value))
  return low === 0 ? 'n' : `${low} + n`
}

/** A Python expression for a value of the column, adding its imports. */
export function sampleValue(column: DbColumn, checks: DbCheck[], enums: DbEnum[], imports: Imports): string {
  const type = column.type
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in' && type.kind !== 'integer' && type.kind !== 'decimal' && type.kind !== 'float')
    return JSON.stringify(choices.values[0])
  switch (type.kind) {
    case 'integer':
      return number(column, checks)
    case 'decimal': {
      imports.from('decimal', 'Decimal')
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      // Small enough for the precision: 1.5, 2.5…, never more digits than the column keeps
      if (integerDigits <= 0) return `Decimal("0.${'5'.padStart(scale, '0')}")`
      return scale > 0
        ? `Decimal(f"{n % ${10 ** Math.min(integerDigits, 4)}}.${'5'.padEnd(scale, '0')}")`
        : `Decimal(n % ${10 ** Math.min(integerDigits, 4)})`
    }
    case 'float':
      return `${number(column, checks)} + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `f"{n:0${length}d}"[-${length}:]`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.min(room, 20))
      return prefix.length > 0 ? `f"${prefix}-{n}"` : `f"{n}"[-${length}:]`
    }
    case 'enum':
      return JSON.stringify(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'True'
    case 'date':
      imports.from('datetime', 'date')
      return 'date(2026, 1, n % 28 + 1)'
    case 'time':
      imports.from('datetime', 'time')
      return 'time(12, n % 60)'
    case 'datetime':
      imports.from('datetime', 'datetime')
      return 'datetime(2026, 1, n % 28 + 1, 12, 0, 0)'
    case 'uuid':
      imports.from('uuid', 'UUID')
      return 'UUID(int=n)'
    case 'binary':
      return 'bytes([n % 256])'
    case 'json':
    case 'array':
      return type.kind === 'array' ? '[]' : '{"n": n}'
    case 'unknown':
      return 'f"value-{n}"'
  }
}

/** A key no row has, as a Python expression, for the tests of missing rows. */
export function missingValue(type: DbType, imports: Imports): string {
  switch (type.kind) {
    case 'integer':
    case 'decimal':
    case 'float':
      return '999999'
    case 'uuid':
      imports.from('uuid', 'UUID')
      return 'UUID(int=999999)'
    default:
      return '"missing"'
  }
}
