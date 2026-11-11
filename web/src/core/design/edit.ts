/**
 * Edits of an API design. Each returns a new design and leaves the previous one untouched, so the history
 * can keep it for undo. After an edit that changes a decision, the caller reconciles the design with the
 * schema (design/propose.ts) so the decisions that depend on it follow.
 */
import {
  FIELD_DECISIONS,
  HTTP_METHODS,
  sameValue,
  type ApiDesign,
  type Decision,
  type Endpoint,
  type FieldDecisionKind,
  type FieldDesign,
  type ResourceDesign,
} from '../api/types.ts'

/** Which decision an edit is about. */
export type DecisionRef =
  { kind: 'expose'; model: string } | { kind: 'key'; model: string } | { kind: FieldDecisionKind; model: string; field: string }

function mapResource(design: ApiDesign, model: string, change: (item: ResourceDesign) => ResourceDesign): ApiDesign {
  return { ...design, resources: design.resources.map((item) => (item.model === model ? change(item) : item)) }
}

function mapField(design: ApiDesign, model: string, field: string, change: (item: FieldDesign) => FieldDesign): ApiDesign {
  return mapResource(design, model, (item) => ({ ...item, fields: item.fields.map((f) => (f.field === field ? change(f) : f)) }))
}

/** The user chooses a value (or confirms the suggestion): the decision becomes active and manual. */
function choose<T>(current: Decision<T>, value: T): Decision<T> {
  return { ...current, value, status: 'active', manual: true }
}

/** The decision an edit refers to, if the design has it. */
export function getDecision(design: ApiDesign, ref: DecisionRef): Decision<unknown> | undefined {
  const resource = design.resources.find((item) => item.model === ref.model)
  if (ref.kind === 'expose') return resource?.expose
  if (ref.kind === 'key') return resource?.key
  return resource?.fields.find((item) => item.field === ref.field)?.[ref.kind]
}

/**
 * Chooses a value for a decision; without a value, confirms the suggestion as it is.
 *
 * @returns The new design, or the same design when the value is not one of the decision's options.
 */
export function decide(design: ApiDesign, ref: DecisionRef, value?: unknown): ApiDesign {
  const current = getDecision(design, ref)
  if (!current) return design
  const next = value === undefined ? current.value : value
  if (!current.options.some((option) => sameValue(option, next))) return design
  if (ref.kind === 'expose')
    return mapResource(design, ref.model, (item) => ({ ...item, expose: choose(item.expose, next as typeof item.expose.value) }))
  if (ref.kind === 'key')
    return mapResource(design, ref.model, (item) => (item.key ? { ...item, key: choose(item.key, next as typeof item.key.value) } : item))
  return mapField(design, ref.model, ref.field, (item) => {
    const decisionOf = item[ref.kind] as Decision<unknown> | undefined
    return decisionOf ? { ...item, [ref.kind]: choose(decisionOf, next) } : item
  })
}

/** Leaves a field out of the API, or brings it back. The key of a resource always stays. */
export function setFieldInclude(design: ApiDesign, model: string, field: string, include: boolean): ApiDesign {
  const resource = design.resources.find((item) => item.model === model)
  if (!include && resource?.key?.value.kind === 'field' && resource.key.value.field === field) return design
  return mapField(design, model, field, (item) => ({ ...item, include }))
}

/** Normalizes a path segment written by the user: lower case, words joined by hyphens, no slashes. */
export function cleanSegment(text: string): string {
  return text
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9_\-/{}]+/g, '-')
    .replace(/-+/g, '-')
}

/** Sets the first segment of a resource's paths; an empty text goes back to the derived one. */
export function setResourcePath(design: ApiDesign, model: string, path: string): ApiDesign {
  const segment = cleanSegment(path).split('/')[0] ?? ''
  return mapResource(design, model, (item) => {
    const { path: _old, ...rest } = item
    return segment ? { ...rest, path: segment } : rest
  })
}

/** The parts of an endpoint the user can change. */
export type EndpointPatch = Partial<
  Pick<
    Endpoint,
    | 'enabled'
    | 'method'
    | 'path'
    | 'name'
    | 'summary'
    | 'access'
    | 'roles'
    | 'status'
    | 'pagination'
    | 'filters'
    | 'sort'
    | 'input'
    | 'output'
  >
>

/** A path written by the user: starts with a slash, no spaces, no trailing slash. */
export function cleanPath(text: string): string {
  const cleaned = cleanSegment(text)
  return `/${cleaned}`
}

/** Changes an endpoint. A path is normalized; an unknown method is ignored. */
export function updateEndpoint(design: ApiDesign, model: string, id: string, patch: EndpointPatch): ApiDesign {
  const next: EndpointPatch = { ...patch }
  if (next.path !== undefined) next.path = cleanPath(next.path)
  if (next.method !== undefined && !HTTP_METHODS.includes(next.method)) delete next.method
  if (next.roles !== undefined) next.roles = [...new Set(next.roles.map((role) => role.trim()).filter(Boolean))]
  return mapResource(design, model, (item) => ({
    ...item,
    endpoints: item.endpoints.map((endpoint) => {
      if (endpoint.id !== id) return endpoint
      const changed = { ...endpoint, ...next }
      if (next.path !== undefined && endpoint.operation !== 'custom') changed.pathEdited = true
      if (patch.status === undefined && 'status' in patch) delete changed.status
      return changed
    }),
  }))
}

/**
 * Adds a business endpoint to a resource, under the path of one item. It starts enabled, receives nothing
 * and returns the resource; the user adapts it, and the generated code marks where its logic goes.
 *
 * @returns The new design and the identifier of the new endpoint.
 */
export function addCustomEndpoint(design: ApiDesign, model: string): { design: ApiDesign; id: string } {
  const resource = design.resources.find((item) => item.model === model)
  if (!resource || resource.expose.value !== 'resource') return { design, id: '' }
  const used = new Set(resource.endpoints.map((endpoint) => endpoint.id))
  let n = 1
  while (used.has(`${model}.custom.${n}`)) n++
  const id = `${model}.custom.${n}`
  const item = resource.endpoints.find((endpoint) => endpoint.operation === 'get')?.path ?? `/${model.toLowerCase()}`
  const endpoint: Endpoint = {
    id,
    operation: 'custom',
    enabled: true,
    method: 'POST',
    path: `${item}/action${n === 1 ? '' : n}`,
    name: `${model.charAt(0).toLowerCase()}${model.slice(1)}Action${n === 1 ? '' : n}`,
    summary: 'Business operation',
    access: 'default',
    roles: [],
    input: 'none',
    output: 'resource',
  }
  return { design: mapResource(design, model, (current) => ({ ...current, endpoints: [...current.endpoints, endpoint] })), id }
}

/** Removes a business endpoint. Standard endpoints are disabled instead, never removed. */
export function removeEndpoint(design: ApiDesign, model: string, id: string): ApiDesign {
  return mapResource(design, model, (item) => ({
    ...item,
    endpoints: item.endpoints.filter((endpoint) => endpoint.id !== id || endpoint.operation !== 'custom'),
  }))
}

/** Every decision that waits for the user, in the order of the design. */
export function pendingDecisions(design: ApiDesign): DecisionRef[] {
  const pending: DecisionRef[] = []
  for (const resource of design.resources) {
    if (resource.expose.status === 'pending') pending.push({ kind: 'expose', model: resource.model })
    if (resource.expose.value === 'resource' && resource.key?.status === 'pending') pending.push({ kind: 'key', model: resource.model })
    for (const field of resource.fields) {
      if (!field.include) continue
      for (const kind of FIELD_DECISIONS)
        if (field[kind]?.status === 'pending') pending.push({ kind, model: resource.model, field: field.field })
    }
  }
  return pending
}
