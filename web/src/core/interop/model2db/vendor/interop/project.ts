import {
  FIELD_DECISIONS,
  perTarget,
  type Confidence,
  type Decision,
  type DecisionStatus,
  type Design,
  type EnumDesign,
  type FieldDesign,
  type ModelDesign,
  type Reason,
  type StorageTarget,
} from '../design/types.ts'
import type { OutputSettings } from '../generate/types.ts'
import { DEFAULT_NAMING } from '../physical/naming.ts'
import type { Dialect, NamingOptions } from '../physical/types.ts'
import { findParser } from '../parsers/registry.ts'
import type { InputFormatId } from '../parsers/types.ts'

/** A saved Model2DB project: the input as written, the decisions of both kinds of database and the output
 * settings, so the review can continue later or on another computer (docs/interoperability.md). */

export const PROJECT_FORMAT = 'model2db-project'
export const PROJECT_VERSION = 1

export interface ProjectInput {
  /** null: detected from the text when the project is opened */
  format: InputFormatId | null
  text: string
  fileName?: string
}

/** One design per kind of database, as the workspace keeps them. */
export type ProjectDesigns = Record<StorageTarget, Design | null>

export interface ProjectOutput {
  output: string
  naming: Record<StorageTarget, NamingOptions>
  strings: OutputSettings['strings']
  engine: Dialect
  migrations: boolean
}

export interface Model2DBProject {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  /** ISO date of the save, for display */
  savedAt: string
  input: ProjectInput
  designs: ProjectDesigns
  output: ProjectOutput
}

export function createProject(input: ProjectInput, designs: ProjectDesigns, output: ProjectOutput, now = new Date()): Model2DBProject {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: now.toISOString(),
    input: { format: input.format, text: input.text, ...(input.fileName ? { fileName: input.fileName } : {}) },
    designs,
    output,
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const STATUSES: readonly DecisionStatus[] = ['active', 'pending']
const CONFIDENCES: readonly Confidence[] = ['exact', 'high', 'probable', 'review', 'conflict', 'none']
const TABLE_NAMING: readonly string[] = ['plural', 'singular', 'model']
const COLUMN_NAMING: readonly string[] = ['snake', 'field']
const STRINGS: readonly string[] = ['auto', 'varchar', 'text']
const DIALECTS: readonly Dialect[] = ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle']

/** A problem in the file, with the path of the first wrong value. */
class Invalid extends Error {
  readonly path: string
  constructor(path: string) {
    super(path)
    this.path = path
  }
}

function check(condition: boolean, path: string): void {
  if (!condition) throw new Invalid(path)
}

const optionalString = (value: unknown, path: string): string | undefined => {
  check(value === undefined || typeof value === 'string', path)
  return value as string | undefined
}

/** A decision as saved. Its value is checked against the schema when the design is reconciled
 * (design/edit.ts): a value the proposal no longer offers is dropped there. */
function readDecision(value: unknown, path: string): Decision<unknown> | undefined {
  if (value === undefined) return undefined
  check(isObject(value), path)
  const decision = value as Json
  check(STATUSES.includes(decision.status as DecisionStatus), `${path}.status`)
  check(CONFIDENCES.includes(decision.confidence as Confidence), `${path}.confidence`)
  check(Array.isArray(decision.options), `${path}.options`)
  check(
    Array.isArray(decision.reasons) && decision.reasons.every((reason) => isObject(reason) && typeof reason.code === 'string'),
    `${path}.reasons`,
  )
  check(decision.manual === undefined || typeof decision.manual === 'boolean', `${path}.manual`)
  return {
    value: decision.value,
    status: decision.status as DecisionStatus,
    confidence: decision.confidence as Confidence,
    ...(decision.manual ? { manual: true } : {}),
    reasons: decision.reasons as Reason[],
    options: decision.options as unknown[],
  }
}

function readField(value: unknown, path: string): FieldDesign {
  check(isObject(value) && typeof value.field === 'string' && typeof value.include === 'boolean', path)
  const field = value as Json
  const result: FieldDesign = { field: field.field as string, include: field.include as boolean }
  for (const kind of FIELD_DECISIONS) {
    const decision = readDecision(field[kind], `${path}.${kind}`)
    if (decision) (result as unknown as Json)[kind] = decision
  }
  check(field.index === undefined || typeof field.index === 'boolean', `${path}.index`)
  if (field.index) result.index = true
  const column = optionalString(field.column, `${path}.column`)
  if (column) result.column = column
  const type = optionalString(field.type, `${path}.type`)
  if (type) result.type = type
  return result
}

function readModel(value: unknown, path: string): ModelDesign {
  check(isObject(value) && typeof value.model === 'string' && typeof value.include === 'boolean' && Array.isArray(value.fields), path)
  const model = value as Json
  const result: ModelDesign = {
    model: model.model as string,
    include: model.include as boolean,
    fields: (model.fields as unknown[]).map((field, index) => readField(field, `${path}.fields[${index}]`)),
  }
  const key = readDecision(model.key, `${path}.key`)
  if (key) result.key = key as ModelDesign['key']
  const table = optionalString(model.table, `${path}.table`)
  if (table) result.table = table
  return result
}

function readEnum(value: unknown, path: string): EnumDesign {
  check(isObject(value) && typeof value.enum === 'string', path)
  const storage = readDecision((value as Json).storage, `${path}.storage`)
  check(storage !== undefined, `${path}.storage`)
  return { enum: (value as Json).enum as string, storage: storage as EnumDesign['storage'] }
}

function readDesign(value: unknown, target: StorageTarget, path: string): Design | null {
  if (value === null) return null
  check(isObject(value) && value.target === target && Array.isArray(value.models) && Array.isArray(value.enums), path)
  const design = value as Json
  return {
    target,
    models: (design.models as unknown[]).map((model, index) => readModel(model, `${path}.models[${index}]`)),
    enums: (design.enums as unknown[]).map((item, index) => readEnum(item, `${path}.enums[${index}]`)),
  }
}

function readNaming(value: unknown, path: string): NamingOptions {
  check(isObject(value) && TABLE_NAMING.includes(String(value.tables)) && COLUMN_NAMING.includes(String(value.columns)), path)
  return { tables: (value as Json).tables, columns: (value as Json).columns } as NamingOptions
}

function readOutput(value: unknown, path: string): ProjectOutput {
  check(isObject(value) && typeof value.output === 'string', path)
  const output = value as Json
  check(isObject(output.naming), `${path}.naming`)
  const naming = output.naming as Json
  check(STRINGS.includes(String(output.strings)), `${path}.strings`)
  check(DIALECTS.includes(output.engine as Dialect), `${path}.engine`)
  check(typeof output.migrations === 'boolean', `${path}.migrations`)
  return {
    output: output.output as string,
    // Projects saved before a kind of database existed have no naming for it
    naming: perTarget((target) =>
      naming[target] === undefined && target !== 'relational' && target !== 'document'
        ? DEFAULT_NAMING[target]
        : readNaming(naming[target], `${path}.naming.${target}`),
    ),
    strings: output.strings as OutputSettings['strings'],
    engine: output.engine as Dialect,
    migrations: output.migrations as boolean,
  }
}

function readInput(value: unknown, path: string): ProjectInput {
  check(isObject(value) && typeof value.text === 'string', path)
  const input = value as Json
  check(
    input.format === null || (typeof input.format === 'string' && findParser(input.format as InputFormatId) !== undefined),
    `${path}.format`,
  )
  const fileName = optionalString(input.fileName, `${path}.fileName`)
  return { format: input.format as InputFormatId | null, text: input.text as string, ...(fileName ? { fileName } : {}) }
}

export type ProjectError = 'notJson' | 'notProject' | 'newerVersion' | 'invalid'
export type ProjectReadResult = { ok: true; project: Model2DBProject } | { ok: false; error: ProjectError; path?: string }

/** Reads a project file. Everything is checked and copied: a damaged or edited file is rejected with the
 * path of the first problem instead of breaking the page later, and unknown keys are left behind. */
export function readProject(text: string): ProjectReadResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'notJson' }
  }
  if (!isObject(value) || value.format !== PROJECT_FORMAT) return { ok: false, error: 'notProject' }
  if (typeof value.version !== 'number' || value.version > PROJECT_VERSION) return { ok: false, error: 'newerVersion' }
  try {
    check(isObject(value.designs), '$.designs')
    const designs = value.designs as Json
    return {
      ok: true,
      project: {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
        input: readInput(value.input, '$.input'),
        designs: perTarget((target) => readDesign(designs[target] ?? null, target, `$.designs.${target}`)),
        output: readOutput(value.output, '$.output'),
      },
    }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: 'invalid', path: error.path }
    throw error
  }
}

/** `order.model2db.json`, from the model the project is mainly about. */
export function projectFileName(title: string | undefined): string {
  const base = (title ?? 'model').replace(/[^\w.-]+/g, '-').toLowerCase() || 'model'
  return `${base}.model2db.json`
}
