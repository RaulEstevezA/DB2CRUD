/**
 * Sample values for the tests every generator writes: request bodies that satisfy the validations the
 * models declare (lengths, ranges, formats, patterns, enums), built once and language-neutral so the
 * tests of every framework send the same data.
 *
 * References to other resources cannot be known in advance: they are listed with their place in the body
 * so the generated test creates the referenced item first and puts its key there.
 */
import type { Constraints } from '../../analysis/constraints.ts'
import type { ApiSpec, SpecField, SpecResource, SpecType } from '../../api/spec.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A place in a body that must hold the key of another resource. */
export interface SampleReference {
  /** Property names and list positions from the root of the body */
  path: (string | number)[]
  resource: string
}

export interface Sample {
  body: { [key: string]: JsonValue }
  references: SampleReference[]
}

/** Why no valid body could be built, in English for a comment in the generated tests; null when it could. */
export type SampleProblem = string | null

class Unsupported extends Error {}

const UUIDS = ['3fa85f64-5717-4562-b3fc-2c963f66afa6', '7c9e6679-7425-40de-944b-e07fc1f90ae7']

/** One character of a class written in a pattern: `A-Z`, `0-9`, `a`, `\d`. */
function classSample(body: string): string {
  if (body.startsWith('^')) throw new Unsupported('negated class')
  if (body.startsWith('\\d')) return '1'
  if (body.startsWith('\\w')) return 'a'
  if (body.startsWith('\\s')) return ' '
  const range = /^(.)-(.)/.exec(body)
  if (range) return range[1]
  return body.startsWith('\\') ? body[1] : body[0]
}

/**
 * Builds a string that a simple regular expression accepts: literals, classes, `\d` `\w` `\s`, groups,
 * alternatives (the first is used) and the quantifiers `? * + {n} {n,} {n,m}`.
 *
 * @returns The string, or null when the pattern uses something else (look-arounds, back-references…).
 */
export function sampleFromPattern(pattern: string): string | null {
  let index = 0
  function atom(): string {
    const char = pattern[index]
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) throw new Unsupported('class')
      const body = pattern.slice(index + 1, end)
      index = end + 1
      return classSample(body)
    }
    if (char === '(') {
      index++
      if (pattern.startsWith('?:', index)) index += 2
      else if (pattern[index] === '?') throw new Unsupported('look-around')
      const value = sequence(')')
      index++
      return value
    }
    if (char === '\\') {
      const next = pattern[index + 1]
      index += 2
      if (next === 'd') return '1'
      if (next === 'w') return 'a'
      if (next === 's') return ' '
      if (/[1-9bBk]/.test(next)) throw new Unsupported('escape')
      return next
    }
    if (char === '.') {
      index++
      return 'a'
    }
    index++
    return char
  }
  function quantified(): string {
    const value = atom()
    const char = pattern[index]
    if (char === '?' || char === '*') {
      index++
      return char === '?' ? value : ''
    }
    if (char === '+') {
      index++
      return value
    }
    if (char === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index))
      if (!match) return value
      index += match[0].length
      return value.repeat(Number(match[1]))
    }
    return value
  }
  function sequence(stop: string | null): string {
    let result = ''
    while (index < pattern.length && pattern[index] !== stop) {
      const char = pattern[index]
      if (char === '^' || char === '$') {
        index++
        continue
      }
      if (char === '|') {
        // The first alternative is enough: skip the rest of this sequence
        let depth = 0
        while (index < pattern.length && !(depth === 0 && pattern[index] === stop)) {
          if (pattern[index] === '\\') index++
          else if (pattern[index] === '(') depth++
          else if (pattern[index] === ')') depth--
          index++
        }
        break
      }
      result += quantified()
    }
    return result
  }
  try {
    const value = sequence(null)
    return new RegExp(pattern).test(value) ? value : null
  } catch {
    return null
  }
}

/** Whether a regular expression accepts a text, as JavaScript reads it; false when the pattern does not compile. */
export function patternAccepts(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

/** A text that respects the field's validations: its format, its pattern or its length. */
function sampleText(constraints: Constraints, name: string, variant: number): string {
  switch (constraints.format) {
    case 'email':
      return `user${variant + 1}@example.com`
    case 'uri':
      return `https://example.com/${name.toLowerCase()}/${variant + 1}`
    case 'uuid':
      return UUIDS[variant % UUIDS.length]
    case 'date':
      return `2024-01-${15 + variant}`
    case 'date-time':
      return `2024-01-${15 + variant}T10:30:00Z`
    case 'time':
      return '10:30:00'
  }
  if (constraints.pattern) {
    const value = sampleFromPattern(constraints.pattern)
    if (value === null) throw new Unsupported(`pattern ${constraints.pattern}`)
    return value
  }
  let text = `${name} ${variant + 1}`
  const min = constraints.minLength ?? 0
  const max = constraints.maxLength ?? Number.POSITIVE_INFINITY
  if (text.length < min) text = text.padEnd(min, 'x')
  if (text.length > max) text = text.slice(0, max)
  return text
}

/** A number inside the field's range, different for each variant where the range allows it. */
function sampleNumber(constraints: Constraints, whole: boolean, variant: number): number {
  const step = whole ? 1 : 0.5
  let low = constraints.minimum ?? (constraints.exclusiveMinimum !== undefined ? constraints.exclusiveMinimum + step : undefined)
  if (constraints.minimum !== undefined && constraints.exclusiveMinimum !== undefined)
    low = Math.max(constraints.minimum, constraints.exclusiveMinimum + step)
  const high = constraints.maximum ?? (constraints.exclusiveMaximum !== undefined ? constraints.exclusiveMaximum - step : undefined)
  let value = (low ?? (whole ? 1 : 1.5)) + variant * step
  if (whole) value = Math.ceil(value)
  if (high !== undefined && value > high) value = Math.max(low ?? high, high)
  return value
}

function sampleOf(
  type: SpecType,
  field: SpecField,
  spec: ApiSpec,
  variant: number,
  path: (string | number)[],
  references: SampleReference[],
  depth: number,
): JsonValue {
  const constraints = field.constraints
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
          return sampleText(constraints, field.name, variant)
        case 'integer':
          return sampleNumber(constraints, true, variant)
        case 'float':
        case 'decimal':
          return sampleNumber(constraints, false, variant)
        case 'boolean':
          return variant % 2 === 0
        case 'date':
          return `2024-01-${15 + variant}`
        case 'datetime':
          return `2024-01-${15 + variant}T10:30:00Z`
        case 'time':
          return '10:30:00'
        case 'duration':
          return 'PT1H'
        case 'uuid':
          return UUIDS[variant % UUIDS.length]
        case 'binary':
          return 'aGVsbG8='
        case 'any':
          return { note: `sample ${variant + 1}` }
      }
      return null
    case 'enum': {
      const values = spec.enums.find((item) => item.name === type.name)?.values ?? []
      if (values.length === 0) throw new Unsupported(`empty enum ${type.name}`)
      return values[variant % values.length]
    }
    case 'object': {
      const object = spec.objects.find((item) => item.name === type.name)
      if (!object || depth > 4) throw new Unsupported(`object ${type.name}`)
      return objectSample(object.fields, spec, variant, path, references, depth + 1)
    }
    case 'array': {
      const count = Math.max(1, field.constraints.minItems ?? 1)
      return Array.from({ length: count }, (_, position) =>
        sampleOf(type.items, { ...field, constraints: {} }, spec, variant, [...path, position], references, depth),
      )
    }
    case 'map':
      return { key: sampleOf(type.value, { ...field, constraints: {} }, spec, variant, [...path, 'key'], references, depth) }
  }
}

/** The body of an object: every field the client may send, references left to fill. */
function objectSample(
  fields: SpecField[],
  spec: ApiSpec,
  variant: number,
  path: (string | number)[],
  references: SampleReference[],
  depth: number,
): { [key: string]: JsonValue } {
  const body: { [key: string]: JsonValue } = {}
  for (const field of fields) {
    if (field.access === 'readOnly') continue
    const here = [...path, field.wire]
    if (field.reference) {
      // An optional reference (a tree's parent) stays out; a required one is filled by the test
      if (!field.required) continue
      if (field.type.kind === 'array') {
        body[field.wire] = [null]
        references.push({ path: [...here, 0], resource: field.reference })
      } else {
        body[field.wire] = null
        references.push({ path: here, resource: field.reference })
      }
      continue
    }
    body[field.wire] = sampleOf(field.type, field, spec, variant, here, references, depth)
  }
  return body
}

/**
 * Builds a valid creation body of a resource.
 *
 * @param spec The resolved API.
 * @param resource The resource.
 * @param variant 0 for the first body, 1 for another one with different values where possible.
 * @returns The body and its references, or the reason no valid body can be built.
 */
export function sampleBody(spec: ApiSpec, resource: SpecResource, variant: number): { sample: Sample; problem: SampleProblem } {
  const references: SampleReference[] = []
  try {
    const body = objectSample(resource.fields, spec, variant, [], references, 0)
    return { sample: { body, references }, problem: null }
  } catch (error) {
    const detail = error instanceof Unsupported ? error.message : String(error)
    return { sample: { body: {}, references: [] }, problem: `No valid sample body could be built (${detail}); write one by hand.` }
  }
}

/** A field a partial update can change in the tests: a plain text or number the client may send. */
export function updatableField(resource: SpecResource): SpecField | null {
  return (
    resource.fields.find(
      (field) =>
        field.access === 'readWrite' &&
        field.name !== resource.key.field &&
        !field.reference &&
        field.type.kind === 'scalar' &&
        ['string', 'integer', 'float', 'decimal'].includes(field.type.scalar) &&
        !field.constraints.pattern &&
        !field.constraints.format,
    ) ?? null
  )
}

/** The resources a resource needs before it can be created, deepest first, without repeats or cycles. */
export function creationOrder(spec: ApiSpec, resource: SpecResource): SpecResource[] {
  const order: SpecResource[] = []
  const visiting = new Set<string>()
  function visit(current: SpecResource) {
    if (visiting.has(current.name) || order.includes(current)) return
    visiting.add(current.name)
    const { sample } = sampleBody(spec, current, 0)
    for (const reference of sample.references) {
      const target = spec.resources.find((item) => item.name === reference.resource)
      if (target && target !== current) visit(target)
    }
    order.push(current)
  }
  visit(resource)
  return order.filter((item) => item !== resource)
}
