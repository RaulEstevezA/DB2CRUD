/**
 * Model2API project files: the input as written, the reviewed design and the project settings, so the
 * review can continue later or on another computer. A file is untrusted input: it is validated piece by
 * piece, and a damaged decision or endpoint is dropped (the proposal fills it again) instead of trusted.
 */
import { HTTP_METHODS, type ApiDesign, type Decision, type Endpoint, type FieldDesign, type ResourceDesign } from '../api/types.ts'
import { DEFAULT_SETTINGS, normalizeSettings, type ProjectSettings } from '../compatibility/stack.ts'
import { findParser } from '../importers/registry.ts'
import type { InputFormatId } from '../importers/types.ts'

export const PROJECT_FORMAT = 'model2api-project'
export const PROJECT_VERSION = 1

export interface ProjectInput {
  /** null: detected from the text when the project is opened */
  format: InputFormatId | null
  text: string
  fileName?: string
}

export interface Model2ApiProject {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  /** ISO date of the save, for display */
  savedAt: string
  input: ProjectInput
  design: ApiDesign | null
  settings: ProjectSettings
}

export type ProjectError = 'notJson' | 'notProject' | 'newerVersion' | 'noInput'

export type ReadProject = { ok: true; project: Model2ApiProject } | { ok: false; error: ProjectError }

export function createProject(
  input: ProjectInput,
  design: ApiDesign | null,
  settings: ProjectSettings,
  now = new Date(),
): Model2ApiProject {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: now.toISOString(),
    input: { format: input.format, text: input.text, ...(input.fileName ? { fileName: input.fileName } : {}) },
    design,
    settings,
  }
}

/** File name of a saved project: `shop-api.model2api.json`. */
export function projectFileName(settings: ProjectSettings): string {
  return `${settings.name}.model2api.json`
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'

const CONFIDENCES = new Set(['exact', 'high', 'probable', 'review', 'conflict', 'none'])

function isDecision(value: unknown): value is Decision<unknown> {
  return (
    isObject(value) &&
    'value' in value &&
    (value.status === 'active' || value.status === 'pending') &&
    CONFIDENCES.has(String(value.confidence)) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => isObject(reason) && isString(reason.code)) &&
    Array.isArray(value.options)
  )
}

function readField(value: unknown): FieldDesign | null {
  if (!isObject(value) || !isString(value.field) || typeof value.include !== 'boolean' || !isDecision(value.access)) return null
  const field: FieldDesign = { field: value.field, include: value.include, access: value.access as FieldDesign['access'] }
  if (isDecision(value.relation)) field.relation = value.relation as FieldDesign['relation']
  if (isDecision(value.unknownType)) field.unknownType = value.unknownType as FieldDesign['unknownType']
  return field
}

const OPERATIONS = new Set(['list', 'get', 'create', 'replace', 'update', 'delete', 'custom'])
const ACCESS = new Set(['default', 'public', 'authenticated', 'roles'])

function readEndpoint(value: unknown): Endpoint | null {
  if (!isObject(value)) return null
  const { id, operation, enabled, method, path, name, summary, access, roles } = value
  if (!isString(id) || !OPERATIONS.has(String(operation)) || typeof enabled !== 'boolean') return null
  if (!HTTP_METHODS.includes(method as Endpoint['method']) || !isString(path) || !isString(name) || !isString(summary)) return null
  if (!ACCESS.has(String(access)) || !Array.isArray(roles) || !roles.every(isString)) return null
  const endpoint: Endpoint = {
    id,
    operation: operation as Endpoint['operation'],
    enabled,
    method: method as Endpoint['method'],
    path,
    name,
    summary,
    access: access as Endpoint['access'],
    roles,
  }
  if (value.pathEdited === true) endpoint.pathEdited = true
  if (typeof value.status === 'number') endpoint.status = value.status
  if (typeof value.pagination === 'boolean') endpoint.pagination = value.pagination
  if (Array.isArray(value.filters) && value.filters.every(isString)) endpoint.filters = value.filters
  if (Array.isArray(value.sort) && value.sort.every(isString)) endpoint.sort = value.sort
  if (value.input === 'none' || value.input === 'resource' || value.input === 'partial') endpoint.input = value.input
  if (value.output === 'none' || value.output === 'resource' || value.output === 'list') endpoint.output = value.output
  return endpoint
}

function readResource(value: unknown): ResourceDesign | null {
  if (!isObject(value) || !isString(value.model) || !isDecision(value.expose)) return null
  const resource: ResourceDesign = {
    model: value.model,
    expose: value.expose as ResourceDesign['expose'],
    fields: Array.isArray(value.fields) ? value.fields.map(readField).filter((field): field is FieldDesign => field !== null) : [],
    endpoints: Array.isArray(value.endpoints)
      ? value.endpoints.map(readEndpoint).filter((endpoint): endpoint is Endpoint => endpoint !== null)
      : [],
  }
  if (isDecision(value.key)) resource.key = value.key as ResourceDesign['key']
  if (isString(value.path) && value.path !== '') resource.path = value.path
  return resource
}

/**
 * Reads a project file.
 *
 * @param text The content of the file.
 * @returns The project, or why it cannot be opened. Settings are normalized; a damaged design keeps only
 *   its valid parts.
 */
export function readProject(text: string): ReadProject {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'notJson' }
  }
  if (!isObject(data) || data.format !== PROJECT_FORMAT || typeof data.version !== 'number') return { ok: false, error: 'notProject' }
  if (data.version > PROJECT_VERSION) return { ok: false, error: 'newerVersion' }
  const input = data.input
  if (!isObject(input) || !isString(input.text)) return { ok: false, error: 'noInput' }
  const format = isString(input.format) && findParser(input.format as InputFormatId) ? (input.format as InputFormatId) : null
  const design =
    isObject(data.design) && Array.isArray(data.design.resources)
      ? { resources: data.design.resources.map(readResource).filter((item): item is ResourceDesign => item !== null) }
      : null
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...(isObject(data.settings) ? (data.settings as Partial<ProjectSettings>) : {}),
  })
  return {
    ok: true,
    project: {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      savedAt: isString(data.savedAt) ? data.savedAt : '',
      input: { format, text: input.text, ...(isString(input.fileName) ? { fileName: input.fileName } : {}) },
      design,
      settings,
    },
  }
}
