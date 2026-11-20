/**
 * Reads a saved Mapper project (`mapper-project`, version 1; Mapper's docs/interoperability.md): both models, as
 * Mapper read them, and the mapping between them, field by field with its transformation. DB2CRUD uses it as the
 * application models: one side is the model of a table, the other the model the services take or return
 * (matching/mapper.ts). Everything used is checked, and a damaged file is rejected with the path of the problem.
 */
import { validateModelSchema } from '../../importers/schema/modelSchema.ts'
import type { Literal, ModelSchema } from '../../model/schema.ts'

export const MAPPER_PROJECT_FORMAT = 'mapper-project'
export const MAPPER_PROJECT_VERSION = 1

/** How the source values become the target value (Mapper's `mapping/types.ts`). */
export type MapperTransform =
  | { kind: 'direct' }
  | { kind: 'concat'; separator: string }
  | { kind: 'split'; separator: string; part: number | 'last' | 'rest' }
  | { kind: 'constant'; value: Literal }
  | { kind: 'boolean'; trueValues: string[] }
  | { kind: 'enum'; pairs: { from: string; to: string }[]; fallback?: string }
  | { kind: 'epoch'; unit: 'seconds' | 'milliseconds' }
  | { kind: 'arithmetic'; operator: '*' | '/' | '+' | '-'; operand: number }
  | { kind: 'object'; mapping: string }
  | { kind: 'collection'; mapping?: string }
  | { kind: 'expression'; expression: string }

export type MapperTransformKind = MapperTransform['kind']

/** active: in the mapping; pending: a suggestion not confirmed; ignored: no value on purpose; unmapped: none found. */
export type MapperFieldStatus = 'active' | 'pending' | 'ignored' | 'unmapped'

export interface MapperField {
  /** The field of the target model */
  target: string
  /** Paths of the source model (`['address', 'city']`) */
  sources: string[][]
  transform: MapperTransform
  status: MapperFieldStatus
}

export interface MapperMapping {
  /** `Source->Target` */
  id: string
  source: string
  target: string
  fields: MapperField[]
  ignoredSources: string[]
}

export interface MapperSide {
  /** The input format Mapper read (`typescript`, `python`…) */
  format: string
  model: string
  schema: ModelSchema
}

export interface MapperProject {
  source: MapperSide
  target: MapperSide
  root: string
  mappings: MapperMapping[]
}

export type MapperReadResult =
  { ok: true; project: MapperProject } | { ok: false; error: 'notJson' | 'notProject' | 'newerVersion' | 'invalid'; path?: string }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

const TRANSFORMS = new Set<string>([
  'direct',
  'concat',
  'split',
  'constant',
  'boolean',
  'enum',
  'epoch',
  'arithmetic',
  'object',
  'collection',
  'expression',
])
const STATUSES = new Set<string>(['active', 'pending', 'ignored', 'unmapped'])

/** Whether a text is a Mapper project, before reading it whole. */
export function isMapperProject(text: string): boolean {
  return /^\s*\{/.test(text) && /"format"\s*:\s*"mapper-project"/.test(text)
}

function readSide(value: unknown, path: string): MapperSide | string {
  if (!isObject(value) || typeof value.format !== 'string' || typeof value.model !== 'string') return path
  const schema = validateModelSchema(value.schema)
  if (!schema.ok) return `${path}.schema${schema.path.slice(1)}`
  return { format: value.format, model: value.model, schema: schema.schema }
}

function readMappings(value: unknown, path: string): { root: string; mappings: MapperMapping[] } | string {
  if (!isObject(value) || typeof value.root !== 'string' || !Array.isArray(value.mappings)) return path
  const mappings: MapperMapping[] = []
  for (const [index, mapping] of value.mappings.entries()) {
    const at = `${path}.mappings[${index}]`
    if (
      !isObject(mapping) ||
      typeof mapping.id !== 'string' ||
      typeof mapping.source !== 'string' ||
      typeof mapping.target !== 'string' ||
      !Array.isArray(mapping.fields)
    )
      return at
    const ignored = mapping.ignoredSources ?? []
    if (!isStringArray(ignored)) return `${at}.ignoredSources`
    const fields: MapperField[] = []
    for (const [fieldIndex, field] of mapping.fields.entries()) {
      const fieldPath = `${at}.fields[${fieldIndex}]`
      if (!isObject(field) || typeof field.target !== 'string') return fieldPath
      if (!Array.isArray(field.sources) || !field.sources.every(isStringArray)) return `${fieldPath}.sources`
      if (!isObject(field.transform) || !TRANSFORMS.has(String(field.transform.kind))) return `${fieldPath}.transform`
      if (!STATUSES.has(String(field.status))) return `${fieldPath}.status`
      fields.push({
        target: field.target,
        sources: field.sources as string[][],
        transform: field.transform as unknown as MapperTransform,
        status: field.status as MapperFieldStatus,
      })
    }
    mappings.push({ id: mapping.id, source: mapping.source, target: mapping.target, fields, ignoredSources: ignored })
  }
  if (!mappings.some((mapping) => mapping.id === value.root)) return `${path}.root`
  return { root: value.root, mappings }
}

/** Reads a Mapper project: its two sides and its mappings. */
export function readMapperProject(text: string): MapperReadResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'notJson' }
  }
  if (!isObject(value) || value.format !== MAPPER_PROJECT_FORMAT) return { ok: false, error: 'notProject' }
  if (typeof value.version !== 'number' || value.version > MAPPER_PROJECT_VERSION) return { ok: false, error: 'newerVersion' }
  const source = readSide(value.source, '$.source')
  if (typeof source === 'string') return { ok: false, error: 'invalid', path: source }
  const target = readSide(value.target, '$.target')
  if (typeof target === 'string') return { ok: false, error: 'invalid', path: target }
  const mapping = readMappings(value.mapping, '$.mapping')
  if (typeof mapping === 'string') return { ok: false, error: 'invalid', path: mapping }
  return { ok: true, project: { source, target, ...mapping } }
}

/** The models of both sides in one schema, each name once (the source's first): what the matching compares. */
export function mapperModels(project: MapperProject): ModelSchema {
  const { source, target } = project
  const models = [...source.schema.models]
  for (const model of target.schema.models) if (!models.some((item) => item.name === model.name)) models.push(model)
  const enums = [...source.schema.enums]
  for (const item of target.schema.enums) if (!enums.some((other) => other.name === item.name)) enums.push(item)
  return { ...source.schema, models, enums }
}

/**
 * Whether a transformation can be undone without loss, so the same relation serves the other direction: a value
 * renamed or converted, an enum whose pairs are one to one, a date as seconds, a number scaled or shifted.
 */
export function invertible(transform: MapperTransform): boolean {
  switch (transform.kind) {
    case 'direct':
    case 'epoch':
      return true
    case 'arithmetic':
      return transform.operand !== 0
    case 'enum': {
      const targets = transform.pairs.map((pair) => pair.to)
      return transform.fallback === undefined && new Set(targets).size === targets.length
    }
    default:
      return false
  }
}
