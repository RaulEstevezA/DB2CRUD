/**
 * Sample values for the generated tests, as TypeScript expressions: each one fits its column (type, length,
 * precision, the CHECK constraints the rules understand) and changes with `n`, a variable of the generated
 * factory, so rows made with different numbers do not clash on unique columns. Mirrors python/samples.ts.
 */
import type { DbCheck, DbColumn, DbEnum, DbType } from '../../schema/types.ts'

function checksOf(column: DbColumn, checks: DbCheck[]) {
  return checks.map((check) => check.parsed).filter((parsed) => parsed !== undefined && parsed.column === column.name)
}

const literal = (value: unknown) =>
  typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(value)

/** A whole number that changes with n and stays above the lower bound a CHECK sets. */
function number(column: DbColumn, checks: DbCheck[]): string {
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in') return literal(choices.values[0])
  let low = 0
  for (const parsed of checksOf(column, checks))
    if (parsed?.kind === 'compare' && (parsed.op === '>' || parsed.op === '>=')) low = Math.max(low, Math.ceil(parsed.value))
  return low === 0 ? 'n' : `${low} + n`
}

const twoDigits = (expression: string) => `String(${expression}).padStart(2, '0')`

/** A TypeScript expression for a value of the column. */
export function sampleValue(column: DbColumn, checks: DbCheck[], enums: DbEnum[]): string {
  const type = column.type
  const choices = checksOf(column, checks).find((parsed) => parsed?.kind === 'in')
  if (choices?.kind === 'in' && type.kind !== 'integer' && type.kind !== 'decimal' && type.kind !== 'float')
    return literal(choices.values[0])
  switch (type.kind) {
    case 'integer':
      return number(column, checks)
    case 'decimal': {
      // Exact decimals are text: small enough for the precision, never more digits than the column keeps
      const scale = type.scale ?? 2
      const integerDigits = type.precision !== undefined ? type.precision - scale : 6
      if (integerDigits <= 0) return `'0.${'5'.padStart(scale, '0')}'`
      const whole = `n % ${10 ** Math.min(integerDigits, 4)}`
      return scale > 0 ? `\`\${${whole}}.${'5'.padEnd(scale, '0')}\`` : `String(${whole})`
    }
    case 'float':
      return `${number(column, checks)} + 0.5`
    case 'text': {
      const length = type.length ?? 40
      if (type.fixed) return `String(n).padStart(${length}, '0').slice(-${length})`
      // The column name and the number, as long as it fits; n stays below 1000 in the tests
      const room = length - 4
      const prefix = column.name
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, Math.max(0, Math.min(room, 20)))
      return prefix.length > 0 ? `\`${prefix}-\${n}\`` : `String(n).slice(-${length})`
    }
    case 'enum':
      return literal(enums.find((item) => item.name === type.name)?.values[0] ?? 'value')
    case 'boolean':
      return 'true'
    case 'date':
      return `\`2026-01-\${${twoDigits('(n % 28) + 1')}}\``
    case 'time':
      return `\`12:\${${twoDigits('n % 60')}}:00\``
    case 'datetime':
      return 'new Date(Date.UTC(2026, 0, (n % 28) + 1, 12, 0, 0))'
    case 'uuid':
      return "`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`"
    case 'binary':
      return 'Buffer.from([n % 256])'
    case 'json':
      return '{ n }'
    case 'array':
      return '[]'
    case 'unknown':
      return '`value-${n}`'
  }
}

/** A key no row has, as a TypeScript expression, for the tests of missing rows. */
export function missingValue(type: DbType): string {
  switch (type.kind) {
    case 'integer':
    case 'float':
      return '999999'
    case 'decimal':
      return "'999999'"
    case 'uuid':
      return "'00000000-0000-4000-8000-000000999999'"
    default:
      return "'missing'"
  }
}
