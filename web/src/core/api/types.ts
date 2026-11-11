/**
 * The API design: every decision Model2API proposes for a model schema (which models become resources,
 * their keys, how related models travel, which fields the client may send or read) and the endpoints of
 * each resource, with how sure each proposal is and why.
 *
 * Designs are plain JSON values. Edits return new designs (design/edit.ts), so undo and redo only keep
 * previous values, and a design can be saved in a project file as it is.
 */

/** The confidence scale of personal_web_style (patterns/confidence-states.md). Exact, high and probable
 * proposals are applied; review and conflict wait for the user and leave a `TODO` in the generated code. */
export type Confidence = 'exact' | 'high' | 'probable' | 'review' | 'conflict' | 'none'

export type DecisionStatus = 'active' | 'pending'

/** Why a proposal was made. Codes are translated by the interface (i18n/messages.ts). */
export interface Reason {
  code: ReasonCode
  params?: Record<string, string | number>
}

export type ReasonCode =
  // Resources
  | 'entityDeclared'
  | 'hasKey'
  | 'standalone'
  | 'valueObject'
  // Keys
  | 'keyDeclared'
  | 'keyNamed'
  | 'keyCandidates'
  | 'keyMissing'
  // Relations
  | 'targetIsResource'
  | 'targetIsValue'
  | 'selfReference'
  | 'listOfResources'
  // Access
  | 'keyGenerated'
  | 'keyFromClient'
  | 'generatedValue'
  | 'secretNamed'
  | 'auditNamed'
  | 'plainField'
  // Types
  | 'unknownType'
  // The user chose it
  | 'manual'

/** One decision. `value` is the proposal while the decision is pending and the choice once it is active;
 * `options` are the values that make sense for this subject. */
export interface Decision<T> {
  value: T
  status: DecisionStatus
  confidence: Confidence
  /** Set when the user made or confirmed the choice. */
  manual?: boolean
  reasons: Reason[]
  options: T[]
}

/** Whether a model gets endpoints of its own, or only travels inside the resources that contain it. */
export type ExposeChoice = 'resource' | 'embedded'

/** The identifier of a resource: one of its fields, or a new one the server generates. */
export type KeyChoice = { kind: 'field'; field: string } | { kind: 'generated'; type: GeneratedKeyType }

export type GeneratedKeyType = 'integer' | 'uuid'

/** How a field whose value is another model travels in requests and responses:
 * - `reference`: the other resource's key (`customerId`), or a list of keys (`tagIds`)
 * - `embedded`: the whole object (or list of objects) inside this one */
export type RelationChoice = 'reference' | 'embedded'

/** What the client can do with a field: send and read it, only read it (the server fills it: keys,
 * timestamps), or only send it (passwords, secrets). */
export type AccessChoice = 'readWrite' | 'readOnly' | 'writeOnly'

/** The type given to a field whose type the input does not define: free JSON, or plain text. */
export type UnknownTypeChoice = 'any' | 'string'

export interface FieldDesign {
  field: string
  /** false: the field is left out of the API */
  include: boolean
  access: Decision<AccessChoice>
  /** Only for fields whose value is another model, or a list of them */
  relation?: Decision<RelationChoice>
  /** Only for fields whose type the input does not define */
  unknownType?: Decision<UnknownTypeChoice>
}

/** The field decisions, in the order the interface shows them. */
export const FIELD_DECISIONS = ['access', 'relation', 'unknownType'] as const

export type FieldDecisionKind = (typeof FIELD_DECISIONS)[number]

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** The standard operations of a resource, and `custom` for business operations written by the user. */
export type Operation = 'list' | 'get' | 'create' | 'replace' | 'update' | 'delete' | 'custom'

export const CRUD_OPERATIONS = ['list', 'get', 'create', 'replace', 'update', 'delete'] as const

/** Who may call an endpoint. `default` follows the project setting; `roles` needs one of `roles`. */
export type EndpointAccess = 'default' | 'public' | 'authenticated' | 'roles'

/** What a custom endpoint receives in its body and returns. */
export type CustomInput = 'none' | 'resource' | 'partial'

export type CustomOutput = 'none' | 'resource' | 'list'

export interface Endpoint {
  /** Stable identifier: `<Model>.<operation>` for the standard ones, `<Model>.custom.<n>` for the others */
  id: string
  operation: Operation
  enabled: boolean
  method: HttpMethod
  /** Full path with its parameters in braces: `/products/{id}/publish` */
  path: string
  /** The user wrote the path of a standard endpoint: it no longer follows the resource path or its key */
  pathEdited?: boolean
  /** Name of the operation in the code and in OpenAPI (`operationId`): `listProducts` */
  name: string
  /** One line for the documentation, in English like the generated code */
  summary: string
  access: EndpointAccess
  /** Roles allowed when `access` is `roles` */
  roles: string[]
  /** Status of a successful response; the operation's usual one when absent */
  status?: number
  /** Lists only: paginated with `page` and `size` */
  pagination?: boolean
  /** Lists only: fields the client may filter on with equality (`?status=paid`) */
  filters?: string[]
  /** Lists only: fields the client may sort by (`?sort=-createdAt`) */
  sort?: string[]
  /** Custom endpoints only */
  input?: CustomInput
  output?: CustomOutput
}

export interface ResourceDesign {
  model: string
  expose: Decision<ExposeChoice>
  /** Only while the model is a resource */
  key?: Decision<KeyChoice>
  /** First segment of the paths, chosen by the user; derived from the model's name when absent */
  path?: string
  fields: FieldDesign[]
  endpoints: Endpoint[]
}

export interface ApiDesign {
  resources: ResourceDesign[]
}

export function findResource(design: ApiDesign, model: string): ResourceDesign | undefined {
  return design.resources.find((item) => item.model === model)
}

export function findFieldDesign(design: ApiDesign, model: string, field: string): FieldDesign | undefined {
  return findResource(design, model)?.fields.find((item) => item.field === field)
}

/** Whether two decision values are the same (they are plain JSON). */
export function sameValue<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A proposal: review and conflict wait for the user, the others are applied. */
export function decision<T>(value: T, confidence: Confidence, reasons: Reason[], options: T[]): Decision<T> {
  return { value, status: confidence === 'review' || confidence === 'conflict' ? 'pending' : 'active', confidence, reasons, options }
}

export function reason(code: ReasonCode, params?: Record<string, string | number>): Reason {
  return params ? { code, params } : { code }
}
