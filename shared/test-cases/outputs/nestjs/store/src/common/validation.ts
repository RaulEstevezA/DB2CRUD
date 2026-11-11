/**
 * Validators class-validator has no decorator for: bounds that exclude the limit.
 */

import { ValidateBy, type ValidationOptions } from 'class-validator'

/** The value must be greater than `limit`. */
export function GreaterThan(limit: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({ name: 'greaterThan', validator: { validate: (value) => typeof value === 'number' && value > limit, defaultMessage: () => `must be greater than ${limit}` } }, options)
}

/** The value must be less than `limit`. */
export function LessThan(limit: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({ name: 'lessThan', validator: { validate: (value) => typeof value === 'number' && value < limit, defaultMessage: () => `must be less than ${limit}` } }, options)
}
