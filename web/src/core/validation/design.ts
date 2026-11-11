/**
 * Consistency checks on an API design before any code is written: routes that clash, operation names
 * the code cannot use, paths without the parameter that identifies an item, filters on fields that cannot
 * be filtered, protection that the chosen authentication cannot enforce.
 *
 * An endpoint with an error is left out of the generated code and of the OpenAPI contract, and the
 * interface says why; a warning is only shown.
 */
import { type ApiDesign, type Endpoint, type ResourceDesign } from '../api/types.ts'
import { keyParam } from '../design/propose.ts'
import { findModel, type ModelSchema } from '../model/schema.ts'
import type { ProjectSettings } from '../compatibility/stack.ts'

export type DesignIssueCode =
  | 'duplicateRoute'
  | 'duplicateName'
  | 'invalidName'
  | 'invalidPath'
  | 'missingKeyParam'
  | 'unexpectedParam'
  | 'invalidFilter'
  | 'invalidSort'
  | 'noRoles'
  | 'bodyOnGet'
  | 'invalidStatus'
  | 'protectionIgnored'
  | 'noEndpoints'

export interface DesignIssue {
  code: DesignIssueCode
  severity: 'error' | 'warning'
  model: string
  /** The endpoint the issue is about, when it is about one */
  endpoint?: string
  params?: Record<string, string | number>
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const SEGMENT = /^(?:[A-Za-z0-9._~-]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/

/** Path parameters in the order they appear: `/orders/{id}/lines/{line}` → `id`, `line`. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]*)\}/g)].map((match) => match[1])
}

/** A path with its parameters blanked, so `/a/{id}` and `/a/{key}` count as the same route. */
function routeShape(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}').toLowerCase()
}

const ITEM_OPERATIONS = new Set(['get', 'replace', 'update', 'delete'])

/** Fields a list can filter or sort by: included values that are text, numbers, dates, booleans or enums,
 * and references to one other resource. */
export function filterableFields(resource: ResourceDesign, schema: ModelSchema): Set<string> {
  const model = findModel(schema, resource.model)
  const filterable = new Set<string>()
  for (const field of resource.fields) {
    const definition = model?.fields.find((item) => item.name === field.field)
    if (!field.include || field.access.value === 'writeOnly' || !definition) continue
    const type = definition.type
    const plain = (type.kind === 'primitive' && !['any', 'binary'].includes(type.name)) || type.kind === 'enum'
    const reference = field.relation?.value === 'reference' && type.kind === 'model'
    if (plain || reference) filterable.add(field.field)
  }
  return filterable
}

function checkEndpoint(resource: ResourceDesign, endpoint: Endpoint, schema: ModelSchema, settings: ProjectSettings): DesignIssue[] {
  const issues: DesignIssue[] = []
  const add = (code: DesignIssueCode, severity: 'error' | 'warning', params?: DesignIssue['params']) =>
    issues.push({ code, severity, model: resource.model, endpoint: endpoint.id, ...(params ? { params } : {}) })

  if (!IDENTIFIER.test(endpoint.name)) add('invalidName', 'error', { name: endpoint.name })
  const segments = endpoint.path.split('/').slice(1)
  if (!endpoint.path.startsWith('/') || segments.some((segment) => !SEGMENT.test(segment)))
    add('invalidPath', 'error', { path: endpoint.path })
  const params = pathParams(endpoint.path)
  const key = keyParam(resource)
  if (ITEM_OPERATIONS.has(endpoint.operation) && !params.includes(key)) add('missingKeyParam', 'error', { param: key })
  if (endpoint.operation !== 'custom') {
    const unexpected = params.filter((param) => !ITEM_OPERATIONS.has(endpoint.operation) || param !== key)
    if (unexpected.length > 0) add('unexpectedParam', 'error', { params: unexpected.join(', ') })
  }
  if (new Set(params).size !== params.length) add('invalidPath', 'error', { path: endpoint.path })
  if (endpoint.operation === 'list') {
    const filterable = filterableFields(resource, schema)
    const badFilters = (endpoint.filters ?? []).filter((field) => !filterable.has(field))
    if (badFilters.length > 0) add('invalidFilter', 'error', { fields: badFilters.join(', ') })
    const badSort = (endpoint.sort ?? []).filter((field) => !filterable.has(field))
    if (badSort.length > 0) add('invalidSort', 'error', { fields: badSort.join(', ') })
  }
  if (endpoint.access === 'roles' && endpoint.roles.length === 0) add('noRoles', 'error')
  if (endpoint.operation === 'custom' && endpoint.method === 'GET' && endpoint.input && endpoint.input !== 'none') add('bodyOnGet', 'error')
  if (endpoint.status !== undefined && (endpoint.status < 200 || endpoint.status > 299 || !Number.isInteger(endpoint.status))) {
    add('invalidStatus', 'error', { status: endpoint.status })
  }
  if (settings.auth === 'none' && (endpoint.access === 'authenticated' || endpoint.access === 'roles')) add('protectionIgnored', 'warning')
  if (settings.auth === 'apiKey' && endpoint.access === 'roles') add('protectionIgnored', 'warning', { auth: 'apiKey' })
  return issues
}

/**
 * Checks every enabled endpoint of a design, and the endpoints of each resource against each other.
 *
 * @param design The design to check.
 * @param schema The models the design is about.
 * @param settings The project settings: authentication decides which protections can be enforced.
 * @returns The issues found, in the order of the design.
 */
export function validateDesign(design: ApiDesign, schema: ModelSchema, settings: ProjectSettings): DesignIssue[] {
  const issues: DesignIssue[] = []
  const routes = new Map<string, string>()
  const names = new Map<string, string>()
  for (const resource of design.resources) {
    if (resource.expose.value !== 'resource') continue
    const enabled = resource.endpoints.filter((endpoint) => endpoint.enabled)
    if (enabled.length === 0) issues.push({ code: 'noEndpoints', severity: 'warning', model: resource.model })
    for (const endpoint of enabled) {
      issues.push(...checkEndpoint(resource, endpoint, schema, settings))
      const route = `${endpoint.method} ${routeShape(endpoint.path)}`
      const clash = routes.get(route)
      if (clash)
        issues.push({ code: 'duplicateRoute', severity: 'error', model: resource.model, endpoint: endpoint.id, params: { other: clash } })
      else routes.set(route, endpoint.id)
      const sameName = names.get(endpoint.name.toLowerCase())
      if (sameName)
        issues.push({ code: 'duplicateName', severity: 'error', model: resource.model, endpoint: endpoint.id, params: { other: sameName } })
      else names.set(endpoint.name.toLowerCase(), endpoint.id)
    }
  }
  return issues
}

/** Identifiers of the endpoints left out of the generated code because of an error. */
export function blockedEndpoints(issues: DesignIssue[]): Set<string> {
  return new Set(issues.filter((issue) => issue.severity === 'error' && issue.endpoint).map((issue) => issue.endpoint!))
}
