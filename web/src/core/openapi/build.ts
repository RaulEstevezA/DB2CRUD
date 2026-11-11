/**
 * Builds the OpenAPI 3.1 contract of a resolved API. It describes exactly what the generators write:
 * the same schemas (read, create, partial update), the same query parameters, the same status codes and
 * the same error body, so the contract and the code of any framework agree.
 */
import type { Constraints } from '../analysis/constraints.ts'
import type { ApiSpec, SpecEndpoint, SpecField, SpecResource, SpecType } from '../api/spec.ts'
import { toYaml, type YamlValue } from './yaml.ts'

type Json = Record<string, unknown>

/** The error codes every generated API answers with, by status. */
export const ERROR_CODES: Record<number, { code: string; description: string }> = {
  400: { code: 'validation_error', description: 'The request is not valid' },
  401: { code: 'unauthorized', description: 'Missing or invalid credentials' },
  403: { code: 'forbidden', description: 'The credentials do not allow this operation' },
  404: { code: 'not_found', description: 'No item has this key' },
  409: { code: 'conflict', description: 'An item with this key already exists' },
  501: { code: 'not_implemented', description: 'The logic of this operation is not written yet' },
}

/** Codes of errors any request can meet, which no operation documents one by one. */
export const GENERAL_ERROR_CODES = ['method_not_allowed', 'internal_error']

/** Query parameters of a paginated list, with the limits every generator enforces. */
export const PAGE_SIZE = { default: 20, max: 100 }

export const schemaNames = {
  read: (resource: SpecResource) => resource.name,
  create: (resource: SpecResource) => `${resource.name}Create`,
  update: (resource: SpecResource) => `${resource.name}Update`,
  page: (resource: SpecResource) => `${resource.name}Page`,
}

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` }
}

/** The JSON Schema of a scalar, an enum, an object or a collection. */
export function typeSchema(type: SpecType): Json {
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
          return { type: 'string' }
        case 'integer':
          return type.bits === 64
            ? { type: 'integer', format: 'int64' }
            : type.bits === 32
              ? { type: 'integer', format: 'int32' }
              : { type: 'integer' }
        case 'float':
          return type.bits === 32 ? { type: 'number', format: 'float' } : { type: 'number' }
        case 'decimal':
          return { type: 'number', format: 'decimal' }
        case 'boolean':
          return { type: 'boolean' }
        case 'date':
          return { type: 'string', format: 'date' }
        case 'datetime':
          return { type: 'string', format: 'date-time' }
        case 'time':
          return { type: 'string', format: 'time' }
        case 'duration':
          return { type: 'string', format: 'duration' }
        case 'uuid':
          return { type: 'string', format: 'uuid' }
        case 'binary':
          return { type: 'string', contentEncoding: 'base64' }
        case 'any':
          return {}
      }
      return {}
    case 'enum':
    case 'object':
      return ref(type.name)
    case 'array':
      return { type: 'array', items: typeSchema(type.items) }
    case 'map':
      return { type: 'object', additionalProperties: typeSchema(type.value) }
  }
}

function withConstraints(schema: Json, constraints: Constraints, type: SpecType): Json {
  const result = { ...schema }
  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'format') {
      if (type.kind === 'scalar' && type.scalar === 'string') result.format = value
    } else result[key] = value
  }
  return result
}

/** The schema of a field: its type, validations, default, description and whether it may be null. */
export function fieldSchema(field: SpecField): Json {
  let schema = withConstraints(typeSchema(field.type), field.constraints, field.type)
  if (field.nullable) {
    if (typeof schema.type === 'string') schema = { ...schema, type: [schema.type, 'null'] }
    else if (Object.keys(schema).length > 0) schema = { anyOf: [schema, { type: 'null' }] }
  }
  if (field.defaultValue !== undefined) schema.default = field.defaultValue
  if (field.description) schema.description = field.description
  return schema
}

type Shape = 'read' | 'create' | 'update' | 'object'

/** Fields of a schema of each shape: what a response holds, what a creation needs, what an update may change. */
export function shapeFields(fields: SpecField[], shape: Shape): SpecField[] {
  if (shape === 'read') return fields.filter((field) => field.access !== 'writeOnly')
  if (shape === 'object') return fields
  return fields.filter((field) => field.access !== 'readOnly')
}

/** Whether a response always holds the field: required ones, those with a default and those the server fills. */
export function alwaysInResponse(field: SpecField): boolean {
  return field.required || field.defaultValue !== undefined || (field.server !== undefined && field.server !== 'pending')
}

function objectSchema(fields: SpecField[], shape: Shape, description?: string): Json {
  const properties: Json = {}
  for (const field of fields) {
    // A response may leave out an optional field or send it as null, depending on the framework
    const readable = shape === 'read' && !alwaysInResponse(field) ? { ...field, nullable: true } : field
    properties[field.wire] = fieldSchema(readable)
  }
  const required =
    shape === 'update'
      ? []
      : shape === 'read'
        ? fields.filter(alwaysInResponse).map((field) => field.wire)
        : fields.filter((field) => field.required).map((field) => field.wire)
  const schema: Json = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  if (shape !== 'read') schema.additionalProperties = false
  if (description) schema.description = description
  return schema
}

function errorSchema(): Json {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: [...Object.values(ERROR_CODES).map((item) => item.code), ...GENERAL_ERROR_CODES] },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'message'],
              properties: { field: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
    },
  }
}

function hasPagination(resource: SpecResource): boolean {
  return resource.endpoints.some((endpoint) => endpoint.pagination)
}

function components(spec: ApiSpec): Json {
  const schemas: Json = {}
  for (const item of spec.enums) schemas[item.name] = { type: item.valueType, enum: item.values }
  for (const object of spec.objects) schemas[object.name] = objectSchema(shapeFields(object.fields, 'object'), 'object', object.description)
  for (const resource of spec.resources) {
    schemas[schemaNames.read(resource)] = objectSchema(shapeFields(resource.fields, 'read'), 'read', resource.description)
    const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
    if (writes) {
      schemas[schemaNames.create(resource)] = objectSchema(shapeFields(resource.fields, 'create'), 'create')
      schemas[schemaNames.update(resource)] = objectSchema(shapeFields(resource.fields, 'update'), 'update')
    }
    if (hasPagination(resource)) {
      schemas[schemaNames.page(resource)] = {
        type: 'object',
        required: ['items', 'total', 'page', 'size'],
        properties: {
          items: { type: 'array', items: ref(schemaNames.read(resource)) },
          total: { type: 'integer', minimum: 0 },
          page: { type: 'integer', minimum: 1 },
          size: { type: 'integer', minimum: 1, maximum: PAGE_SIZE.max },
        },
      }
    }
  }
  schemas.Error = errorSchema()
  const result: Json = { schemas }
  if (spec.auth === 'apiKey') result.securitySchemes = { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }
  if (spec.auth === 'jwt') result.securitySchemes = { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
  return result
}

function errorResponse(status: number): Json {
  return { description: ERROR_CODES[status].description, content: { 'application/json': { schema: ref('Error') } } }
}

/** The error statuses an endpoint can answer with, in order. */
export function errorStatuses(resource: SpecResource, endpoint: SpecEndpoint, auth: ApiSpec['auth']): number[] {
  const statuses = new Set<number>()
  if (
    endpoint.input !== 'none' ||
    endpoint.pathParams.length > 0 ||
    endpoint.pagination ||
    endpoint.filters.length > 0 ||
    endpoint.sort.length > 0
  ) {
    statuses.add(400)
  }
  if (endpoint.access !== 'public' && auth !== 'none') statuses.add(401)
  if (endpoint.access === 'roles') statuses.add(403)
  if (endpoint.pathParams.some((param) => param.name === resource.key.param)) statuses.add(404)
  if (endpoint.operation === 'create' && resource.key.generated === null) statuses.add(409)
  if (endpoint.operation === 'custom') statuses.add(501)
  return [...statuses].sort((a, b) => a - b)
}

function queryParameters(resource: SpecResource, endpoint: SpecEndpoint): Json[] {
  const parameters: Json[] = []
  if (endpoint.pagination) {
    parameters.push({ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } })
    parameters.push({
      name: 'size',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: PAGE_SIZE.max, default: PAGE_SIZE.default },
    })
  }
  for (const wire of endpoint.filters) {
    const field = resource.fields.find((item) => item.wire === wire)!
    parameters.push({ name: wire, in: 'query', schema: typeSchema(field.type) })
  }
  if (endpoint.sort.length > 0) {
    parameters.push({
      name: 'sort',
      in: 'query',
      description: 'Field to sort by; a leading "-" sorts in descending order',
      schema: { type: 'string', enum: endpoint.sort.flatMap((wire) => [wire, `-${wire}`]) },
    })
  }
  return parameters
}

function successResponse(resource: SpecResource, endpoint: SpecEndpoint): Json {
  if (endpoint.output === 'none' || endpoint.status === 204) return { description: 'Done' }
  const schema =
    endpoint.output === 'list'
      ? endpoint.pagination
        ? ref(schemaNames.page(resource))
        : { type: 'array', items: ref(schemaNames.read(resource)) }
      : ref(schemaNames.read(resource))
  return { description: 'Success', content: { 'application/json': { schema } } }
}

function operation(spec: ApiSpec, resource: SpecResource, endpoint: SpecEndpoint): Json {
  const result: Json = { operationId: endpoint.name, summary: endpoint.summary, tags: [resource.plural] }
  if (endpoint.access === 'roles') result.description = `Requires one of the roles: ${endpoint.roles.join(', ')}.`
  const parameters = [
    ...endpoint.pathParams.map((param) => ({ name: param.name, in: 'path', required: true, schema: typeSchema(param.type) })),
    ...queryParameters(resource, endpoint),
  ]
  if (parameters.length > 0) result.parameters = parameters
  if (endpoint.input !== 'none') {
    const schema = endpoint.input === 'partial' ? schemaNames.update(resource) : schemaNames.create(resource)
    result.requestBody = { required: true, content: { 'application/json': { schema: ref(schema) } } }
  }
  const responses: Json = { [String(endpoint.status)]: successResponse(resource, endpoint) }
  for (const status of errorStatuses(resource, endpoint, spec.auth)) responses[String(status)] = errorResponse(status)
  result.responses = responses
  if (spec.auth !== 'none') result.security = endpoint.access === 'public' ? [] : [{ [spec.auth === 'jwt' ? 'bearer' : 'apiKey']: [] }]
  return result
}

/** The OpenAPI path of an endpoint (identical to the path of the design). */
function paths(spec: ApiSpec): Json {
  const result: Record<string, Json> = {}
  for (const resource of spec.resources) {
    for (const endpoint of resource.endpoints) {
      result[endpoint.path] ??= {}
      result[endpoint.path][endpoint.method.toLowerCase()] = operation(spec, resource, endpoint)
    }
  }
  return result
}

/**
 * Builds the contract.
 *
 * @param spec The resolved API.
 * @param serverUrl Address the generated project listens on when run locally.
 * @returns The OpenAPI document as a plain object.
 */
export function buildOpenApi(spec: ApiSpec, serverUrl: string): Json {
  return {
    openapi: '3.1.0',
    info: { title: spec.title, version: '0.1.0', description: `REST API generated by Model2API. Review it before using it in production.` },
    servers: [{ url: serverUrl }],
    tags: spec.resources.map((resource) => ({ name: resource.plural })),
    paths: paths(spec),
    components: components(spec),
  }
}

/** The contract as YAML, the format the generated projects ship. */
export function openApiYaml(spec: ApiSpec, serverUrl: string): string {
  return toYaml(buildOpenApi(spec, serverUrl) as YamlValue)
}
