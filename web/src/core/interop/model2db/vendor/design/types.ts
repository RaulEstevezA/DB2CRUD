/** The persistence design: every decision Model2DB proposes for a model schema, with how sure it is and
 * why, so the user can review it before any code is written. Decisions are plain JSON values; edits
 * return new designs (design/edit.ts), so undo and redo only keep previous values. */

/** Where the models are stored. Relational covers every SQL dialect; document is MongoDB and Couchbase;
 * keyvalue is Redis; widecolumn is Cassandra and ScyllaDB. */
export type StorageTarget = 'relational' | 'document' | 'keyvalue' | 'widecolumn'

export const STORAGE_TARGETS: readonly StorageTarget[] = ['relational', 'document', 'keyvalue', 'widecolumn']

/** A value for each kind of database. */
export function perTarget<T>(value: (target: StorageTarget) => T): Record<StorageTarget, T> {
  return Object.fromEntries(STORAGE_TARGETS.map((target) => [target, value(target)])) as Record<StorageTarget, T>
}

/** The confidence scale of personal_web_style (patterns/confidence-states.md). Exact, high and probable
 * proposals are applied; review and conflict wait for the user. */
export type Confidence = 'exact' | 'high' | 'probable' | 'review' | 'conflict' | 'none'

export type DecisionStatus = 'active' | 'pending'

/** Why a proposal was made. Codes are translated by the interface (i18n/messages.ts). */
export interface Reason {
  code: ReasonCode
  params?: Record<string, string | number>
}

export type ReasonCode =
  // Keys
  | 'keyDeclared'
  | 'keyNamed'
  | 'keyCandidates'
  | 'keyMissing'
  | 'keyMongo'
  // Relations
  | 'relationDeclared'
  | 'selfReference'
  | 'targetHasKey'
  | 'valueObject'
  | 'notFlattenable'
  | 'backReference'
  | 'bothSidesLists'
  | 'sharedTarget'
  | 'ownedList'
  | 'primitiveList'
  | 'freeShape'
  | 'mapOfValues'
  | 'recursiveEmbed'
  | 'unboundedList'
  | 'targetExcluded'
  // Keys and values
  | 'keySet'
  | 'listAsJson'
  | 'valueList'
  | 'valueHash'
  | 'valueAsJson'
  // Documents
  | 'valueArray'
  // Wide columns
  | 'valueType'
  | 'partitionTable'
  | 'embeddedList'
  | 'nativeCollection'
  // Foreign keys by name
  | 'foreignKeyNamed'
  // Unique
  | 'uniqueDeclared'
  | 'uniqueNamed'
  // Whole numbers
  | 'wholeNumberNamed'
  // Enums
  | 'enumCheck'
  | 'enumDocument'
  // Models
  | 'parentOnly'
  // The user chose it
  | 'manual'

/** One decision. `value` is the proposal while the decision is pending and the choice once it is active;
 * `options` are the values that make sense for this subject. */
export interface Decision<T> {
  value: T
  status: DecisionStatus
  confidence: Confidence
  /** Set when the user made or confirmed the choice */
  manual?: boolean
  reasons: Reason[]
  options: T[]
}

/** The primary key of a stored model: one of its fields, or a new column the database fills. */
export type KeyChoice = { kind: 'field'; field: string } | { kind: 'surrogate'; type: SurrogateType }

/** `objectId` is MongoDB's own `_id`. */
export type SurrogateType = 'integer' | 'uuid' | 'objectId'

/** How a field whose value is another model, a list or a map is stored.
 *
 * Relational:
 * - `reference`: a foreign key column to the other model's table (many-to-one, or one-to-one if unique)
 * - `flatten`: the other model's fields become columns of this table (`address_city`), a value object
 * - `child`: a list stored in another table that points back to this one (one-to-many); for a list of
 *   plain values, a table with one value per row
 * - `join`: a list stored in a table between both models (many-to-many)
 * - `array`: a native array column (PostgreSQL)
 * - `json`: a JSON column
 *
 * Document:
 * - `embed`: the value is stored inside the document
 * - `reference`: the document stores the other document's `_id` (or a list of them)
 * - `child`: a list kept on the other side: the other documents store this one's `_id`, so it is not stored here
 *
 * Keys and values:
 * - `reference`: a hash field holding the other model's key
 * - `flatten`: the other model's fields become fields of this hash
 * - `child`: a list, set or hash of its own under this model's key (`order:42:tags`); for a list of other
 *   models, a set of their keys
 * - `json`: a hash field holding JSON text
 *
 * Wide columns:
 * - `reference`: a column holding the other model's key
 * - `embed`: a user-defined type in the row (`frozen<address>`), or a list of them
 * - `flatten`: the other model's fields become columns of this table
 * - `child`: a table of its own partitioned by this model's key, with the other models' keys
 * - `array`: a native collection (`list<text>`, `map<text, int>`)
 * - `json`: a text column holding JSON
 */
export type RelationChoice = 'reference' | 'flatten' | 'child' | 'join' | 'array' | 'json' | 'embed'

/** How an enum is stored in a relational database. Documents always use the validator's `enum`. */
export type EnumChoice = 'check' | 'native' | 'lookup' | 'text'

export interface FieldDesign {
  field: string
  /** false: the field is not stored (computed values, data that belongs elsewhere) */
  include: boolean
  /** Only for fields whose value is another model, a list or a map */
  relation?: Decision<RelationChoice>
  /** A scalar field that holds another model's key (`customerId`): the model it points to, or null */
  foreignKey?: Decision<string | null>
  unique?: Decision<boolean>
  /** Only for numbers without a size (TypeScript's `number`): true stores a whole number (INTEGER) */
  wholeNumber?: Decision<boolean>
  /** A plain index on the column, chosen by the user (foreign keys are indexed on their own) */
  index?: boolean
  /** Column or property name chosen by the user, instead of the one derived from the field */
  column?: string
  /** Database type written by the user (`VARCHAR(80)`), instead of the one derived from the field */
  type?: string
}

/** The field decisions, in the order the interface shows them. */
export const FIELD_DECISIONS = ['relation', 'foreignKey', 'unique', 'wholeNumber'] as const

export type FieldDecisionKind = (typeof FIELD_DECISIONS)[number]

export interface ModelDesign {
  model: string
  /** Only for models no other model refers to: false leaves them out of the database */
  include: boolean
  /** Only for models stored on their own (see physical/roles.ts) */
  key?: Decision<KeyChoice>
  fields: FieldDesign[]
  /** Table or collection name chosen by the user */
  table?: string
}

export interface EnumDesign {
  enum: string
  storage: Decision<EnumChoice>
}

export interface Design {
  target: StorageTarget
  models: ModelDesign[]
  enums: EnumDesign[]
}

export function findModelDesign(design: Design, model: string): ModelDesign | undefined {
  return design.models.find((item) => item.model === model)
}

export function findFieldDesign(design: Design, model: string, field: string): FieldDesign | undefined {
  return findModelDesign(design, model)?.fields.find((item) => item.field === field)
}

export function sameValue<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
