import type { Literal, Primitive } from '../model/schema.ts'

/** The database a design turns into, independent of the dialect: tables, columns, keys and indexes, or
 * collections with their validators. Only active decisions reach it; pending ones become `todos`. */

export type ColumnType =
  | { kind: 'primitive'; name: Primitive; bits?: 8 | 16 | 32 | 64; length?: number; precision?: number; scale?: number }
  | { kind: 'enum'; name: string }
  | { kind: 'json' }
  | { kind: 'array'; items: ColumnType }
  /** Written by the user: used as it is */
  | { kind: 'raw'; sql: string }

export interface Column {
  name: string
  type: ColumnType
  nullable: boolean
  defaultValue?: Literal
  /** Filled by the database: an identity (auto-increment), a generated UUID or the current time */
  generated?: 'identity' | 'uuid' | 'now'
  /** `Order.customer.city`: where the column comes from, for the comments and the interface */
  source?: string
}

export interface ForeignKey {
  name: string
  columns: string[]
  table: string
  references: string[]
  /** `cascade` for rows that only exist as part of their owner (order lines, list values) */
  onDelete?: 'cascade' | 'set null'
  /** Field of the table's model this key stands for (`Order.customer` → `customer`), for ORM navigation */
  field?: string
  /** Field of the referenced model that lists the rows of this table (`Order.lines`) */
  inverse?: string
}

export interface Index {
  name: string
  columns: string[]
  unique: boolean
}

export interface Check {
  name: string
  column: string
  values: (string | number)[]
}

/** Something the user still has to decide; the generated code says it in a comment. */
export interface Todo {
  code: TodoCode
  params: Record<string, string>
}

export type TodoCode = 'relationPending' | 'keyPending' | 'targetNotStored' | 'foreignKeyTargetNotStored'

export type TableKind = 'entity' | 'list' | 'map' | 'join' | 'lookup'

export interface Table {
  name: string
  kind: TableKind
  /** The model it stores; for list, map and join tables, the model that owns them */
  model: string
  /** The field a list, map or join table comes from */
  field?: string
  /** Join tables: the field of the other model that lists back, when both sides list each other */
  mirror?: string
  columns: Column[]
  primaryKey: string[]
  foreignKeys: ForeignKey[]
  uniques: Index[]
  indexes: Index[]
  checks: Check[]
  todos: Todo[]
}

export interface PhysicalEnum {
  name: string
  /** Name of the database type (`order_status`) or of the lookup table */
  sqlName: string
  values: (string | number)[]
  storage: 'check' | 'native' | 'lookup' | 'text'
}

export interface Note {
  code: NoteCode
  params: Record<string, string>
}

export type NoteCode =
  | 'arrayAsJson'
  | 'nativeEnumAsCheck'
  | 'defaultPrecision'
  | 'inheritedFields'
  | 'cycleEmbedded'
  | 'renamedReserved'
  /** A text without a length is part of a key or an index: the engine needs one */
  | 'textKeyLength'
  /** Written by an output: the ORM has no composite primary keys, so the table gets an `id` */
  | 'compositeKeyAsId'
  /** Written by an output: the ORM checks enum values in the application, not in the database */
  | 'enumCheckedInCode'
  /** Written by an output: the ORM stores an enum with an enum type of its own instead of a CHECK */
  | 'ormEnumType'
  /** Written by an output: values of a PostgreSQL enum type need a cast the ORM cannot write */
  | 'enumNeedsCast'
  /** Written by an output: the ORM has no composite keys, so it creates and reads those rows but does not update them */
  | 'compositeKeyReadOnly'
  /** Written by an output: the database has no unique indexes, so the application keeps the value unique */
  | 'uniqueInApplication'

export interface RelationalSchema {
  kind: 'relational'
  tables: Table[]
  enums: PhysicalEnum[]
  notes: Note[]
}

/** A field of a MongoDB `$jsonSchema` validator. */
export interface BsonSchema {
  bsonType?: string | string[]
  enum?: Literal[]
  required?: string[]
  properties?: Record<string, BsonSchema>
  items?: BsonSchema
  additionalProperties?: boolean | BsonSchema
  description?: string
}

export interface Collection {
  name: string
  model: string
  validator: BsonSchema
  indexes: Index[]
  todos: Todo[]
}

export interface DocumentSchema {
  kind: 'document'
  collections: Collection[]
  notes: Note[]
}

/** What a hash field, or each item of a list, set or hash, holds. Redis keeps everything as text. */
export type KeyValueHolds = 'text' | 'number' | 'boolean' | 'date' | 'json' | 'key'

/** A field of a model's hash. */
export interface HashField {
  name: string
  holds: KeyValueHolds
  /** For `key`: the prefix of the keys it holds (`customer`) */
  refers?: string
  /** For an enum: the values it accepts */
  values?: Literal[]
  nullable: boolean
  source: string
}

/** A list, set or hash of its own under the owner's key: `order:<key>:tags`. */
export interface KeyStructure {
  suffix: string
  type: 'list' | 'set' | 'hash'
  holds: KeyValueHolds
  refers?: string
  source: string
}

/** A hash field in the model's search index (Redis Query Engine). */
export interface SearchField {
  field: string
  type: 'TAG' | 'NUMERIC'
}

/** The keys of a stored model: a hash under `prefix:<key>`, and what hangs from it. */
export interface KeyEntry {
  model: string
  prefix: string
  /** The field whose value is the key, or null when the application makes one */
  keyField: string | null
  /** How a new key is made when no field holds it */
  newKey: 'counter' | 'uuid' | null
  fields: HashField[]
  structures: KeyStructure[]
  search: SearchField[]
  todos: Todo[]
}

export interface KeyValueSchema {
  kind: 'keyvalue'
  entries: KeyEntry[]
  notes: Note[]
}

/** A column of a Cassandra or ScyllaDB table, or a field of a user-defined type. The type is CQL as both
 * write it (`text`, `list<frozen<order_line>>`). */
export interface CqlColumn {
  name: string
  type: string
  source?: string
}

export interface CqlTable {
  name: string
  model: string
  /** `entity`: a stored model; `child`: the keys of a list of other models, partitioned by the owner's key */
  kind: 'entity' | 'child'
  columns: CqlColumn[]
  partitionKey: string[]
  clusteringKey: string[]
  /** Secondary indexes, on one column each */
  indexes: { name: string; column: string }[]
  todos: Todo[]
}

/** A user-defined type: a model without a key kept inside the rows that use it. */
export interface CqlType {
  name: string
  fields: CqlColumn[]
}

export interface WideColumnSchema {
  kind: 'widecolumn'
  /** In the order they can be created: a type comes after the types it uses */
  types: CqlType[]
  tables: CqlTable[]
  notes: Note[]
}

export type PhysicalSchema = RelationalSchema | DocumentSchema | KeyValueSchema | WideColumnSchema

export type TableNaming = 'plural' | 'singular' | 'model'
export type ColumnNaming = 'snake' | 'field'

export interface NamingOptions {
  tables: TableNaming
  columns: ColumnNaming
}

export type Dialect = 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'sqlserver' | 'oracle'

export interface BuildOptions {
  naming: NamingOptions
  dialect: Dialect
  /** Type of a text whose input declares no length: `auto` is TEXT in PostgreSQL and SQLite, where it costs
   * nothing, and VARCHAR(255) in the others, where unbounded text cannot be indexed */
  strings: 'auto' | 'varchar' | 'text'
}
