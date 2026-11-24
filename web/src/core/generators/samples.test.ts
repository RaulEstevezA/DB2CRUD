import { describe, expect, it } from 'vitest'
import { checkOf } from '../schema/checks.ts'
import { boundedNumber } from './samples.ts'

const bounds = (...checks: string[]) => checks.map((check) => checkOf(check).parsed)

describe('the numbers of the tests', () => {
  it('stay within the bounds of the CHECKs', () => {
    expect(boundedNumber([], 'n', false)).toBe('n')
    expect(boundedNumber(bounds('a >= 5'), 'n', false)).toBe('5 + n')
    expect(boundedNumber(bounds('a >= 1', 'a <= 5'), '$n', false)).toBe('1 + $n % 5')
    expect(boundedNumber(bounds('a > 0', 'a < 5'), 'n', false)).toBe('1 + n % 4')
    expect(boundedNumber(bounds('a <= 100'), 'n', false)).toBe('n % 101')
    expect(boundedNumber(bounds('a >= 0', 'a <= 5'), 'n', true)).toBe('n % 5')
    expect(boundedNumber(bounds('a >= 0', 'a <= 100000'), 'n', false)).toBe('n')
  })
})
