/** What the sample values of every language share. */
import type { DbCheck } from '../schema/types.ts'

type Parsed = DbCheck['parsed']

/**
 * A whole number that changes with `n` (a variable that is never 0) and stays within the bounds the CHECKs of a column
 * set. With an upper one it repeats: no more values fit. A number with decimals leaves room for the half added to it.
 */
export function boundedNumber(checks: Parsed[], n: string, decimals: boolean): string {
  let low = 0
  let first = 0
  let high = Infinity
  for (const parsed of checks) {
    if (parsed?.kind !== 'compare') continue
    if (parsed.op === '>' || parsed.op === '>=') {
      low = Math.max(low, Math.ceil(parsed.value))
      first = Math.max(first, parsed.op === '>' ? Math.floor(parsed.value) + 1 : Math.ceil(parsed.value))
    } else high = Math.min(high, parsed.op === '<' ? Math.ceil(parsed.value) - 1 : Math.floor(parsed.value))
  }
  const room = high - first + (decimals ? 0 : 1)
  // The numbers of the tests stay below 1000
  if (room >= 1 && room < 1000) return first === 0 ? `${n} % ${room}` : `${first} + ${n} % ${room}`
  return low === 0 ? n : `${low} + ${n}`
}
