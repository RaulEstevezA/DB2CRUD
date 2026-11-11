/**
 * Rules the generated tests of every framework share, so each one checks the same things in its own
 * syntax: which resources a test can create through the API, which key no item has, which fields can be
 * compared after a round trip, and the credentials the tests use.
 */
import type { ApiSpec, SpecEndpoint, SpecResource } from '../../api/spec.ts'
import { shapeFields } from '../../openapi/build.ts'
import { sampleBody, type JsonValue } from './samples.ts'

/** The API key the tests configure and send. */
export const TEST_API_KEY = 'test-api-key'

/** The secret the tests sign their tokens with: long enough for every JWT library's minimum. */
export const TEST_JWT_SECRET = 'test-secret-with-at-least-32-bytes!'

/** A key no stored item has, by key type, as text for a path. */
export function missingKey(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return '999999'
  if (resource.key.type.scalar === 'uuid') return '00000000-0000-0000-0000-000000000000'
  return 'missing-key'
}

/** A path with a fixed key value and any other parameter filled: `/customers/999999`. */
export function fixedPath(endpoint: SpecEndpoint, resource: SpecResource, value: string): string {
  let path = endpoint.path
  for (const param of endpoint.pathParams) path = path.replace(`{${param.name}}`, param.name === resource.key.param ? value : 'sample')
  return path
}

/** A path whose key is an expression of the test language: `replaceKey` turns `{key}` into its syntax. */
export function pathWithKey(endpoint: SpecEndpoint, resource: SpecResource): string {
  let path = endpoint.path
  for (const param of endpoint.pathParams) path = path.replace(`{${param.name}}`, param.name === resource.key.param ? '{key}' : 'sample')
  return path
}

export function findEndpoint(resource: SpecResource, operation: SpecEndpoint['operation']): SpecEndpoint | undefined {
  return resource.endpoints.find((endpoint) => endpoint.operation === operation)
}

/** The JSON name of the key of a resource. */
export function keyWire(resource: SpecResource): string {
  return resource.fields.find((field) => field.name === resource.key.field)!.wire
}

/** Whether tests can create items of a resource: a create endpoint, a valid body and creatable references. */
export function creatable(spec: ApiSpec, resource: SpecResource, seen = new Set<string>()): boolean {
  if (!findEndpoint(resource, 'create') || sampleBody(spec, resource, 0).problem) return false
  if (seen.has(resource.name)) return true
  const next = new Set([...seen, resource.name])
  return sampleBody(spec, resource, 0).sample.references.every((reference) => {
    const target = spec.resources.find((item) => item.name === reference.resource)
    return target !== undefined && creatable(spec, target, next)
  })
}

/** Fields a round trip returns exactly as sent: readable text, whole numbers, booleans and enums. */
export function comparableFields(resource: SpecResource, body: Record<string, JsonValue>): string[] {
  const readable = new Set(shapeFields(resource.fields, 'read').map((field) => field.wire))
  return resource.fields
    .filter((field) => readable.has(field.wire) && !field.reference && field.wire in body)
    .filter(
      (field) =>
        (field.type.kind === 'scalar' && ['string', 'integer', 'boolean'].includes(field.type.scalar) && !field.constraints.format) ||
        field.type.kind === 'enum',
    )
    .map((field) => field.wire)
}

/** Whether the two sample bodies give different client-provided keys, so two items can be created. */
export function sampleKeysDiffer(spec: ApiSpec, resource: SpecResource): boolean {
  if (resource.key.generated !== null) return true
  const key = keyWire(resource)
  return JSON.stringify(sampleBody(spec, resource, 0).sample.body[key]) !== JSON.stringify(sampleBody(spec, resource, 1).sample.body[key])
}

/** A required field the client sends, to check that leaving it out is rejected. */
export function requiredField(resource: SpecResource) {
  return resource.fields.find((field) => field.required && field.access !== 'readOnly' && !field.reference) ?? null
}

/** The first protected endpoint a test can call without a body, to check it needs credentials. */
export function protectedEndpoint(resource: SpecResource, auth: ApiSpec['auth']): SpecEndpoint | null {
  if (auth === 'none') return null
  const endpoint = resource.endpoints.find((item) => item.access !== 'public')
  return endpoint && endpoint.method === 'GET' && endpoint.input === 'none' ? endpoint : null
}

/** The first endpoint that needs roles a test can call without a body, to check a token without them. */
export function roleEndpoint(resource: SpecResource, auth: ApiSpec['auth']): SpecEndpoint | null {
  if (auth !== 'jwt') return null
  return (
    resource.endpoints.find((endpoint) => endpoint.access === 'roles' && endpoint.method === 'GET' && endpoint.input === 'none') ?? null
  )
}

/** Words of an operation name for a test name: `listCustomers` → `list_customers`. */
export function snakeWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
