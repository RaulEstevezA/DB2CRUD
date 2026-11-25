/**
 * What every file of a Rust project needs to know about each table, computed once: the names of its types, fields
 * and modules, its columns with their Rust types, its key, the decisions of the review and the queries and operations
 * that are on. Types are written with their full path (`chrono::NaiveDate`), so files import only traits and the
 * crate's own items. Mirrors the Kotlin context (kotlin/context.ts).
 */
import type {
  ChildrenPolicy,
  CrudDesign,
  OperationDesign,
  QueryDesign,
  RepositoryDesign,
  ServiceDesign,
  TablePolicy,
} from '../../crud/types.ts'
import { findPolicy, findRepository, findService } from '../../crud/types.ts'
import type { DbColumn, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import type { ProjectSettings } from '../../settings/settings.ts'
import { toSnakeCase } from '../../model/naming.ts'
import type { RustOrm } from './orm.ts'
import { nestedStructs, valueType, type NestedStruct } from './documents.ts'
import { columnVariant, snakeName, typeName } from './rust.ts'

/** The crates a type comes from, besides the standard library. */
export type Crate = 'chrono' | 'rust_decimal' | 'uuid'

export interface ColumnInfo {
  column: DbColumn
  /** Field of the entity, the SeaORM model and the DTOs: `password_hash` (`r#type` when it is a keyword) */
  field: string
  /** The variant of SeaORM's `Column`: `PasswordHash` */
  variant: string
  /** The name as text, for errors and the contract: `password_hash` */
  key: string
  /** Rust type of the value, without `Option`: `i64`, `rust_decimal::Decimal` */
  rs: string
  crate: Crate | null
  /** Whether the value is copied rather than cloned */
  copy: boolean
  /** The client never sends it on create: the database fills it */
  generated: boolean
  /** Required on create: not null, no default, not generated */
  required: boolean
}

export interface ChildLink {
  table: string
  columns: string[]
  references: string[]
}

export interface TableInfo {
  table: DbTable
  name: string
  entity: string
  /** `order_line`: the module of the table's files when the code is by layer */
  module: string
  /** `order_lines`: the module of the table when the code is by table, and its repository in the unit of work */
  attr: string
  columns: ColumnInfo[]
  key: ColumnInfo[]
  role: TablePolicy['role']['value']
  soft: ColumnInfo | null
  version: ColumnInfo | null
  hidden: string[]
  children: { policy: ChildrenPolicy; links: ChildLink[] } | null
  queries: QueryDesign[]
  operations: OperationDesign[]
  repository: RepositoryDesign
  service: ServiceDesign | null
  writesEntity: boolean
  /** The structs of its nested documents, by column: only in document databases */
  nested: Map<string, NestedStruct>
}

export interface Context {
  orm: RustOrm
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
  /** The name of the crate, as code names it: `data_access` */
  crate: string
}

/** The Rust type of a database value, and the crate it comes from. */
export function rsType(type: DbType): { rs: string; crate: Crate | null; copy: boolean } {
  switch (type.kind) {
    case 'integer':
      return { rs: type.bits === 16 ? 'i16' : type.bits === 64 ? 'i64' : 'i32', crate: null, copy: true }
    case 'decimal':
      return { rs: 'rust_decimal::Decimal', crate: 'rust_decimal', copy: true }
    case 'float':
      return { rs: type.bits === 32 ? 'f32' : 'f64', crate: null, copy: true }
    case 'boolean':
      return { rs: 'bool', crate: null, copy: true }
    case 'date':
      return { rs: 'chrono::NaiveDate', crate: 'chrono', copy: true }
    case 'time':
      return { rs: 'chrono::NaiveTime', crate: 'chrono', copy: true }
    case 'datetime':
      return type.timezone
        ? { rs: 'chrono::DateTime<chrono::FixedOffset>', crate: 'chrono', copy: true }
        : { rs: 'chrono::NaiveDateTime', crate: 'chrono', copy: true }
    case 'uuid':
      return { rs: 'uuid::Uuid', crate: 'uuid', copy: true }
    case 'binary':
      return { rs: 'Vec<u8>', crate: null, copy: false }
    // JSON (and arrays, kept as JSON) as its text; enums as their value; unknown types as their text
    case 'json':
    case 'array':
    case 'text':
    case 'enum':
    case 'unknown':
      return { rs: 'String', crate: null, copy: false }
  }
}

const BLOCKING = new Set([undefined, 'no action', 'restrict'])

function blockingLinks(schema: DbSchema, table: DbTable): ChildLink[] {
  return schema.tables.flatMap((other) =>
    other.foreignKeys
      .filter((key) => key.references.table === table.name && BLOCKING.has(key.onDelete))
      .map((key) => ({ table: other.name, columns: key.columns, references: key.references.columns })),
  )
}

const included = <T extends { include: { value: boolean } }>(items: T[]) => items.filter((item) => item.include.value)

function columnInfo(column: DbColumn, type: ReturnType<typeof rsType>, own: boolean): ColumnInfo {
  const generated = column.generated !== undefined && column.generated !== 'onUpdateNow'
  // MongoDB's `_id` is the `id` of the entity, unless the documents have one of their own
  const field = own ? 'document_id' : snakeName(column.name)
  return {
    column,
    field,
    variant: columnVariant(field),
    key: field.replace(/^r#/, ''),
    ...type,
    generated,
    required: !column.nullable && column.default === undefined && !generated,
  }
}

function tableInfo(orm: RustOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings, table: DbTable): TableInfo {
  const policy = findPolicy(design, table.name)!
  const repository = findRepository(design, table.name)!
  const service = settings.services ? (findService(design, table.name) ?? null) : null
  const entity = typeName(repository.entity)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const ownEntities = !orm.documents && !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  const module = snakeName(entity)
  const attr = snakeName(table.name)
  const nested = orm.documents
    ? nestedStructs(table.columns, entity, entityModule(settings, module, attr, writesEntity))
    : new Map<string, NestedStruct>()
  const ownId = orm.documents === true && table.columns.some((column) => column.name === 'id')
  const columns = table.columns.map((column) =>
    columnInfo(
      column,
      orm.documents ? valueType(column.type, nested.get(column.name)?.path ?? null) : rsType(column.type),
      ownId && column.name === '_id',
    ),
  )
  const byName = (name: string) => columns.find((info) => info.column.name === name)!
  // A table without a primary key is read only; its rows are told apart by all their columns
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  return {
    table,
    name: table.name,
    entity,
    module,
    attr,
    columns,
    key,
    role: policy.role.value,
    soft: deleteMode.mode === 'soft' ? byName(deleteMode.column) : null,
    version: concurrency.mode === 'version' ? byName(concurrency.column) : null,
    hidden: policy.hidden.value,
    children: policy.children ? { policy: policy.children.value, links: blockingLinks(schema, table) } : null,
    queries: included(repository.queries),
    operations: service ? included(service.operations) : [],
    repository,
    service,
    writesEntity,
    nested,
  }
}

export function createContext(orm: RustOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings): Context {
  return {
    orm,
    schema,
    design,
    settings,
    tables: schema.tables.map((table) => tableInfo(orm, schema, design, settings, table)),
    crate: settings.name.replace(/-/g, '_'),
  }
}

export const writesEntities = (context: Context) => context.tables.some((info) => info.writesEntity)

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

export const columnOf = (info: TableInfo, name: string) => info.columns.find((column) => column.column.name === name)!

/** The type of a value that is stored: `Option` only when the column takes null. */
export const storedType = (column: ColumnInfo) => (column.column.nullable ? `Option<${column.rs}>` : column.rs)

/** The value of a field that may be empty (an `Option`), copied. */
export const optionOf = (expression: string, column: ColumnInfo) => (column.copy ? expression : `${expression}.clone()`)

/** The value of an entity's field known to be set: `entity.id.expect(…)` (copied), or as it is when it takes null. */
export const stored = (expression: string, column: ColumnInfo) =>
  column.column.nullable
    ? optionOf(expression, column)
    : `${optionOf(expression, column)}.expect(${JSON.stringify(`${column.key} is set`)})`

// Modules and names

export type Kind = 'entity' | 'table' | 'repository' | 'service' | 'dtos'

const LAYERS: Record<Kind, string> = {
  entity: 'entities',
  table: 'entities',
  repository: 'repositories',
  service: 'services',
  dtos: 'dtos',
}

/** The module of an entity, before its table is known. */
function entityModule(settings: ProjectSettings, module: string, attr: string, written: boolean): string {
  if (!written) return `${settings.entitiesModule.split('.').join('::')}::${module}`
  return settings.architecture === 'table' ? `crate::${attr}::entity` : `crate::${LAYERS.entity}::${module}`
}

/** The module of one kind of file of a table: `crate::repositories::order_line` or `crate::order_lines::repository`. */
export function moduleOf(context: Context, info: TableInfo, kind: Kind): string {
  if ((kind === 'entity' || kind === 'table') && !info.writesEntity) {
    const base = context.settings.entitiesModule.split('.').join('::')
    return `${base}::${kind === 'table' ? `${info.module}_table` : info.module}`
  }
  if (context.settings.architecture === 'table') return `crate::${info.attr}::${kind}`
  return `crate::${LAYERS[kind]}::${kind === 'table' ? `${info.module}_table` : info.module}`
}

/** `crate::errors::DomainError` */
export const pathIn = (module: string, name: string) => `${module}::${name}`

/** The file of a module: `crate::repositories::order_line` → `src/repositories/order_line.rs`. */
export function fileOf(module: string): string {
  const parts = module
    .split('::')
    .slice(1)
    .map((part) => part.replace(/^r#/, ''))
  return `src/${parts.join('/')}.rs`
}

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

/** `find_by_id`: the Rust name of a repository query. */
export function queryName(context: Context, query: QueryDesign): string {
  const name = query.kind === 'getByKey' || query.kind === 'findByUnique' ? readName(context, query.name, false) : query.name
  return snakeName(toSnakeCase(name))
}

export function operationName(context: Context, operation: OperationDesign): string {
  const name =
    operation.kind === 'get'
      ? readName(context, operation.name, true)
      : operation.kind === 'find'
        ? readName(context, operation.name, false)
        : operation.name
  return snakeName(toSnakeCase(name))
}

export const repositoryTrait = (info: TableInfo) => `${info.entity}Repository`
export const sqlRepository = (info: TableInfo) => `Sql${info.entity}Repository`
export const memoryRepository = (info: TableInfo) => `Memory${info.entity}Repository`
export const serviceType = (info: TableInfo) => `${info.entity}Service`

export function query(info: TableInfo, kind: QueryDesign['kind'], columns?: string[]): QueryDesign | undefined {
  return info.queries.find((item) => item.kind === kind && (!columns || item.columns.join(',') === columns.join(',')))
}

/** The type of a table's key: `i64`, or a tuple when it has several columns. */
export const keyType = (info: TableInfo) => (info.key.length === 1 ? info.key[0].rs : `(${info.key.map((column) => column.rs).join(', ')})`)

/** The file of a Rust module: its `use` lines and body (false, null and undefined lines are left out). */
export function rsFile(
  path: string,
  uses: string,
  body: (string | false | null | undefined)[],
  doc: string[] = [],
): { path: string; content: string } {
  const docLines = doc.map((line) => (line === '' ? '//!' : `//! ${line}`))
  const content = [...docLines, ...(docLines.length > 0 ? [''] : []), ...(uses !== '' ? [uses, ''] : []), ...body, '']
  return { path, content: content.filter((line): line is string => typeof line === 'string').join('\n') }
}

/** Indents the lines that apply. */
export const ind = (items: string[], spaces = 4): string[] => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
