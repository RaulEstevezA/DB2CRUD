/**
 * What every file of a C# project needs to know about each table, computed once: the names of its classes,
 * properties and namespaces, its columns with their C# types, its key, the decisions of the review and the queries
 * and operations that are on. Mirrors the Java context (java/context.ts).
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
import { localName, pascalName } from './csharp.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Property of the entity, in PascalCase */
  prop: string
  /** Name of a local or parameter for it, in camelCase */
  local: string
  /** C# type without `?`: `long`, `decimal`, `string` */
  cs: string
  /** A value type (`long`), not a reference type (`string`) */
  valueType: boolean
  /** The property may hold null: the column is nullable, or the database fills it when it is left unset */
  optional: boolean
  /** `long?`, `string` */
  propType: string
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
  /** The namespace of the table when the code is by table: `OrderLines` */
  folder: string
  /** Property of the unit of work and the DbContext: `OrderLines` */
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
}

export interface Context {
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
  /** The root namespace: `App` */
  base: string
}

/** The C# type of a database value. */
export function csType(type: DbType, database: string): { cs: string; valueType: boolean } {
  switch (type.kind) {
    case 'integer':
      return { cs: type.bits === 16 ? 'short' : type.bits === 64 ? 'long' : 'int', valueType: true }
    case 'decimal':
      return { cs: 'decimal', valueType: true }
    case 'float':
      return { cs: type.bits === 32 ? 'float' : 'double', valueType: true }
    case 'boolean':
      return { cs: 'bool', valueType: true }
    case 'date':
      return { cs: 'DateOnly', valueType: true }
    case 'time':
      // Npgsql reads a time with a time zone as a DateTimeOffset
      return { cs: type.timezone && database === 'postgresql' ? 'DateTimeOffset' : 'TimeOnly', valueType: true }
    case 'datetime':
      return { cs: type.timezone ? 'DateTimeOffset' : 'DateTime', valueType: true }
    case 'uuid':
      return { cs: 'Guid', valueType: true }
    case 'binary':
      return { cs: 'byte[]', valueType: false }
    // JSON (and arrays, kept as JSON) as its text; enums as their value
    case 'json':
    case 'array':
    case 'text':
    case 'enum':
    case 'unknown':
      return { cs: 'string', valueType: false }
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

function columnInfo(column: DbColumn, entity: string, primary: boolean, database: string): ColumnInfo {
  const generated = column.generated !== undefined && column.generated !== 'onUpdateNow'
  const base = pascalName(column.name)
  // A member cannot have the name of its class
  const prop = base === entity ? `${base}Value` : base
  const { cs, valueType } = csType(column.type, database)
  const optional = !primary && (column.nullable || column.default !== undefined || column.generated !== undefined)
  return {
    column,
    prop,
    local: localName(column.name),
    cs,
    valueType,
    optional,
    propType: optional ? `${cs}?` : cs,
    generated,
    required: !column.nullable && column.default === undefined && !generated,
  }
}

function tableInfo(schema: DbSchema, design: CrudDesign, settings: ProjectSettings, table: DbTable): TableInfo {
  const policy = findPolicy(design, table.name)!
  const repository = findRepository(design, table.name)!
  const service = settings.services ? (findService(design, table.name) ?? null) : null
  const entity = pascalName(repository.entity)
  const keyNames = table.primaryKey ?? []
  const columns = table.columns.map((column) => columnInfo(column, entity, keyNames.includes(column.name), settings.database))
  const byName = (name: string) => columns.find((info) => info.column.name === name)!
  // A table without a primary key is read only, keyless for EF Core; its rows are told apart by all their columns
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const ownEntities = !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  const folder = pascalName(table.name)
  return {
    table,
    name: table.name,
    entity,
    folder: folder === entity ? `${folder}Table` : folder,
    attr: pascalName(table.name) === entity ? `${pascalName(table.name)}Rows` : pascalName(table.name),
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
  }
}

export function createContext(schema: DbSchema, design: CrudDesign, settings: ProjectSettings): Context {
  return { schema, design, settings, tables: schema.tables.map((table) => tableInfo(schema, design, settings, table)), base: 'App' }
}

export const writesEntities = (context: Context) => context.tables.some((info) => info.writesEntity)

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

export const columnOf = (info: TableInfo, name: string) => info.columns.find((column) => column.column.name === name)!

// Namespaces and names

export type Kind = 'entity' | 'repository' | 'service' | 'dtos'

/** The namespace of one kind of class of a table: `App.Repositories` or `App.Tables.OrderLines`. */
export function namespaceOf(context: Context, info: TableInfo, kind: Kind): string {
  if (kind === 'entity' && !info.writesEntity) return context.settings.entitiesModule
  if (context.settings.architecture === 'table') return `${context.base}.Tables.${info.folder}`
  return `${context.base}.${{ entity: 'Entities', repository: 'Repositories', service: 'Services', dtos: 'Dtos' }[kind]}`
}

/** The folder of a namespace, under src/App: `App.Tables.OrderLines` → `src/App/Tables/OrderLines`. */
export function pathOf(ns: string, name: string, test = false): string {
  const parts = ns.split('.')
  const root = test ? 'tests/App.Tests' : 'src/App'
  const inner = test ? parts.slice(2) : parts.slice(1)
  return [root, ...inner, `${name}.cs`].join('/')
}

export const errorsNamespace = (context: Context) => `${context.base}.Errors`
export const commonNamespace = (context: Context) => `${context.base}.Common`

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

const method = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}Async`

/** `FindByIdAsync`: the C# name of a repository query. */
export function queryName(context: Context, query: QueryDesign): string {
  if (query.kind === 'getByKey' || query.kind === 'findByUnique') return method(readName(context, query.name, false))
  return method(query.name)
}

export function operationName(context: Context, operation: OperationDesign): string {
  if (operation.kind === 'get') return method(readName(context, operation.name, true))
  if (operation.kind === 'find') return method(readName(context, operation.name, false))
  return method(operation.name)
}

export const repositoryInterface = (info: TableInfo) => `I${info.entity}Repository`
export const sqlRepositoryClass = (info: TableInfo) => `Sql${info.entity}Repository`
export const memoryRepositoryClass = (info: TableInfo) => `Memory${info.entity}Repository`
export const serviceClass = (info: TableInfo) => `${info.entity}Service`

export function query(info: TableInfo, kind: QueryDesign['kind'], columns?: string[]): QueryDesign | undefined {
  return info.queries.find((item) => item.kind === kind && (!columns || item.columns.join(',') === columns.join(',')))
}

/** The type a repository is used through: its interface, or the database class when there are none. */
export const repositoryType = (context: Context, info: TableInfo) =>
  context.settings.repositoryInterfaces ? repositoryInterface(info) : sqlRepositoryClass(info)
