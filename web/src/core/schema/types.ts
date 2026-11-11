/**
 * The physical schema of a database that already exists (`db-schema`, docs/design.md): tables, columns
 * with their types as declared, keys, indexes, foreign keys and checks. Every database input (a Model2DB
 * project, ORM code, SQL DDL) is read into this one format, so everything after the importers only knows
 * it. It is plain JSON with a format name and a version, so Model2DB can export it too (decision 15).
 */
import type { Literal } from '../model/schema.ts'

export const DB_SCHEMA_FORMAT = 'db-schema'
export const DB_SCHEMA_VERSION = 1

/** Every engine a schema can describe; the generators say which ones they support. */
export type Dialect = 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'sqlserver' | 'oracle'

/** Where a fact was read in the input text, for explanations; lines and columns start at 1. */
export interface Origin {
  line: number
  column: number
}

/** A column type. `sql` keeps the type as the input declares it (`NUMERIC(10,2)`), so an entity can be written
 * exactly; the rest is what the rules understand of it. `unknown` is a type the rules do not know. */
export type DbType = { sql: string } & (
  | { kind: 'integer'; bits: 16 | 32 | 64 }
  | { kind: 'decimal'; precision?: number; scale?: number }
  | { kind: 'float'; bits: 32 | 64 }
  | { kind: 'text'; length?: number; fixed?: boolean }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'time'; timezone: boolean }
  | { kind: 'datetime'; timezone: boolean }
  | { kind: 'uuid' }
  | { kind: 'binary'; length?: number }
  | { kind: 'json' }
  | { kind: 'enum'; name: string }
  | { kind: 'array'; items: DbType }
  | { kind: 'unknown' }
)

export type DbTypeKind = DbType['kind']

export type DbDefault = { kind: 'literal'; value: Literal } | { kind: 'expression'; sql: string }

/** How the database fills a column the application never sends on insert. */
export type DbGenerated = 'identity' | 'uuid' | 'now' | 'onUpdateNow' | { computed: string }

export interface DbColumn {
  name: string
  type: DbType
  nullable: boolean
  default?: DbDefault
  generated?: DbGenerated
  /** Attribute name in the ORM class, when it differs from the column: `createdAt` for `created_at` */
  attribute?: string
  comment?: string
  origin?: Origin
}

export type ReferentialAction = 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action'

export interface DbForeignKey {
  name?: string
  columns: string[]
  references: { table: string; schema?: string; columns: string[] }
  /** undefined: not declared, so the engine's default (NO ACTION) applies */
  onDelete?: ReferentialAction
  onUpdate?: ReferentialAction
  /** ORM navigation names, when the input has them: `Order.customer` and `Customer.orders` */
  attribute?: string
  inverse?: string
}

export interface DbIndex {
  name?: string
  columns: string[]
}

/** A CHECK constraint. `parsed` holds the forms the rules understand; anything else keeps only `sql`. */
export interface DbCheck {
  name?: string
  sql: string
  parsed?:
    | { kind: 'in'; column: string; values: (string | number)[] }
    | { kind: 'compare'; column: string; op: CompareOp; value: number }
    | { kind: 'length'; column: string; op: CompareOp; value: number }
}

export type CompareOp = '>' | '>=' | '<' | '<='

export interface DbTable {
  name: string
  /** Namespace of the table: `sales` in `sales.orders` */
  schema?: string
  columns: DbColumn[]
  /** null: the table has no primary key */
  primaryKey: string[] | null
  foreignKeys: DbForeignKey[]
  /** UNIQUE constraints and unique indexes */
  uniques: DbIndex[]
  /** Indexes that are not unique */
  indexes: DbIndex[]
  checks: DbCheck[]
  /** Class name when the input is ORM code or a Model2DB project: `Customer` for `customers` */
  entity?: string
  comment?: string
  origin?: Origin
}

export interface DbEnum {
  name: string
  values: string[]
  /** `native`: a type of the database (PostgreSQL `CREATE TYPE … AS ENUM`, MySQL `ENUM(…)`); `check`: a CHECK */
  storage: 'native' | 'check'
}

/** Something read but not understood, kept so the interface can show it. */
export interface DbNote {
  code: string
  params?: Record<string, string | number>
  origin?: Origin
}

export interface DbSchema {
  format: typeof DB_SCHEMA_FORMAT
  version: typeof DB_SCHEMA_VERSION
  /** null when the input does not say (ORM code without a configured engine) */
  dialect: Dialect | null
  source: { kind: 'model2db' | 'orm' | 'ddl'; format: string }
  tables: DbTable[]
  enums: DbEnum[]
  notes: DbNote[]
}

/** The table with this name (and namespace, when given). */
export function findTable(schema: DbSchema, name: string, namespace?: string): DbTable | undefined {
  return schema.tables.find((table) => table.name === name && (namespace === undefined || table.schema === namespace))
}

/** The column with this name. */
export function findColumn(table: DbTable, name: string): DbColumn | undefined {
  return table.columns.find((column) => column.name === name)
}

/** Whether these columns, in any order, are the primary key or a unique constraint of the table. */
export function isUniqueKey(table: DbTable, columns: string[]): boolean {
  const same = (other: string[]) => other.length === columns.length && other.every((column) => columns.includes(column))
  return (table.primaryKey !== null && same(table.primaryKey)) || table.uniques.some((unique) => same(unique.columns))
}
