/**
 * What every file of a Swift project needs to know about each table, computed once: the names of its types and
 * properties, the folder of its files, its columns with their Swift types, its key, the decisions of the review and the
 * queries and operations that are on. A Swift package is one module, so the folders only group files; every type name
 * is unique in it. Mirrors the Kotlin context (kotlin/context.ts).
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
import type { SwiftOrm } from './orm.ts'
import { nestedStructs, valueType, type NestedStruct } from './documents.ts'
import { memberName, typeName } from './swift.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Property of the entity, the model and the DTOs: `passwordHash` (between backticks when it is a keyword) */
  prop: string
  /** The name as text, for the contract: `passwordHash` */
  key: string
  /** Swift type of the value, without `?`: `Int`, `Decimal` */
  sw: string
  /** Whether its values can be ordered with `<` */
  comparable: boolean
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
  /** The Fluent model of the table: `CustomerModel` */
  model: string
  /** `OrderLines`, the folder of the table when the code is by table */
  folder: string
  /** Property of the unit of work: `orderLines` */
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
  orm: SwiftOrm
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
  /** The library module: `DataAccess` */
  module: string
}

/** The Swift type of a database value. */
export function swType(type: DbType): { sw: string; comparable: boolean } {
  switch (type.kind) {
    case 'integer':
      return { sw: 'Int', comparable: true }
    case 'decimal':
      return { sw: 'Decimal', comparable: true }
    case 'float':
      return { sw: type.bits === 32 ? 'Float' : 'Double', comparable: true }
    case 'boolean':
      return { sw: 'Bool', comparable: false }
    case 'date':
    case 'datetime':
      return { sw: 'Date', comparable: true }
    // Swift has no time of the day: TimeOfDay, in Common.swift
    case 'time':
      return { sw: 'TimeOfDay', comparable: true }
    case 'uuid':
      return { sw: 'UUID', comparable: true }
    case 'binary':
      // Data, which the drivers write as bytes (an array of UInt8 goes in as an array)
      return { sw: 'Data', comparable: false }
    // JSON (and arrays, kept as JSON) as its text; enums as their value; unknown types as their text
    case 'json':
    case 'array':
    case 'text':
    case 'enum':
    case 'unknown':
      return { sw: 'String', comparable: true }
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

function columnInfo(column: DbColumn, type: { sw: string; comparable: boolean }, own: boolean): ColumnInfo {
  const generated = column.generated !== undefined && column.generated !== 'onUpdateNow'
  // MongoDB's `_id` is the `id` of the entity, unless the documents have one of their own
  const prop = own ? 'documentId' : memberName(column.name)
  return {
    column,
    prop,
    key: prop.replace(/`/g, ''),
    ...type,
    generated,
    required: !column.nullable && column.default === undefined && !generated,
  }
}

function tableInfo(orm: SwiftOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings, table: DbTable): TableInfo {
  const policy = findPolicy(design, table.name)!
  const repository = findRepository(design, table.name)!
  const service = settings.services ? (findService(design, table.name) ?? null) : null
  const entity = typeName(repository.entity)
  const nested = orm.documents ? nestedStructs(table.columns, entity) : new Map<string, NestedStruct>()
  const ownId = orm.documents === true && table.columns.some((column) => column.name === 'id')
  const columns = table.columns.map((column) =>
    columnInfo(
      column,
      orm.documents ? valueType(column.type, nested.get(column.name)?.path ?? null) : swType(column.type),
      ownId && column.name === '_id',
    ),
  )
  const byName = (name: string) => columns.find((info) => info.column.name === name)!
  // A table without a primary key is read only; its rows are told apart by all their columns
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const ownEntities = !orm.documents && !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  return {
    table,
    name: table.name,
    entity,
    model: `${entity}Model`,
    folder: typeName(table.name),
    attr: memberName(table.name),
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

export function createContext(orm: SwiftOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings): Context {
  return {
    orm,
    schema,
    design,
    settings,
    tables: schema.tables.map((table) => tableInfo(orm, schema, design, settings, table)),
    module: typeName(settings.name),
  }
}

/** Whether a column of the project holds a time of the day. */
export const usesTimes = (context: Context) => context.tables.some((info) => info.columns.some((column) => column.sw === 'TimeOfDay'))

export const writesEntities = (context: Context) => context.tables.some((info) => info.writesEntity)

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

export const columnOf = (info: TableInfo, name: string) => info.columns.find((column) => column.column.name === name)!

/** The type of a value that is stored: `?` only when the column takes null. */
export const storedType = (column: ColumnInfo) => (column.column.nullable ? `${column.sw}?` : column.sw)

/** The value of a property known to be set: `entity.email!`, or as it is when the column takes null. */
export const stored = (expression: string, column: ColumnInfo) => (column.column.nullable ? expression : `${expression}!`)

// Folders and names

export type Kind = 'entity' | 'model' | 'repository' | 'service' | 'dtos'

const LAYERS: Record<Kind, string> = {
  entity: 'Entities',
  model: 'Entities',
  repository: 'Repositories',
  service: 'Services',
  dtos: 'DTOs',
}

/** The file of one kind of type of a table: `Sources/DataAccess/Repositories/OrderLineRepository.swift`. */
export function fileOf(context: Context, info: TableInfo, kind: Kind, name: string): string {
  const folder = context.settings.architecture === 'table' ? info.folder : LAYERS[kind]
  return `Sources/${context.module}/${folder}/${name}.swift`
}

/** The file of a type the whole project shares: `Sources/DataAccess/UnitOfWork.swift`. */
export const sharedFile = (context: Context, name: string) => `Sources/${context.module}/${name}.swift`

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

/** `findById`: the Swift name of a repository query. */
export function queryName(context: Context, query: QueryDesign): string {
  if (query.kind === 'getByKey' || query.kind === 'findByUnique') return readName(context, query.name, false)
  return query.name
}

export function operationName(context: Context, operation: OperationDesign): string {
  if (operation.kind === 'get') return readName(context, operation.name, true)
  if (operation.kind === 'find') return readName(context, operation.name, false)
  return operation.name
}

export const repositoryProtocol = (info: TableInfo) => `${info.entity}Repository`
export const sqlRepository = (info: TableInfo) => `Sql${info.entity}Repository`
export const memoryRepository = (info: TableInfo) => `Memory${info.entity}Repository`
export const serviceType = (info: TableInfo) => `${info.entity}Service`

export function query(info: TableInfo, kind: QueryDesign['kind'], columns?: string[]): QueryDesign | undefined {
  return info.queries.find((item) => item.kind === kind && (!columns || item.columns.join(',') === columns.join(',')))
}

/** The type a repository is used through: its protocol, or the database class when there are none. */
export const repositoryType = (context: Context, info: TableInfo) =>
  context.settings.repositoryInterfaces ? `any ${repositoryProtocol(info)}` : sqlRepository(info)

/** The type of a table's key: `Int`, or a tuple when it has several columns. */
export const keyType = (info: TableInfo) =>
  info.key.length === 1 ? info.key[0].sw : `(${info.key.map((column) => `${column.key}: ${column.sw}`).join(', ')})`

/** The file of a Swift source: its imports and body (false, null and undefined lines are left out). */
export function swFile(path: string, header: string, body: (string | false | null | undefined)[]): { path: string; content: string } {
  const content = [...(header !== '' ? [header, ''] : []), ...body, '']
  return { path, content: content.filter((line): line is string => typeof line === 'string').join('\n') }
}

/** Indents the lines that apply. */
export const ind = (items: string[], spaces = 4): string[] => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
