/**
 * What every file of a TypeScript project needs to know about each table, computed once: the names of its
 * classes, properties and modules, its columns with their TypeScript types, its key, the decisions of the review
 * and the queries and operations that are on. Mirrors the Python context (python/common/context.ts).
 */
import type {
  ChildrenPolicy,
  CrudDesign,
  OperationDesign,
  QueryDesign,
  RepositoryDesign,
  ServiceDesign,
  TablePolicy,
} from '../../../crud/types.ts'
import { findPolicy, findRepository, findService } from '../../../crud/types.ts'
import type { DbColumn, DbSchema, DbTable, DbType } from '../../../schema/types.ts'
import type { ProjectSettings } from '../../../settings/settings.ts'
import { fileName, memberName, typeName } from '../typescript.ts'
import type { TsOrm } from './orm.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Property of the entity: the column name in camelCase */
  prop: string
  /** TypeScript type of the value, without `| null` */
  ts: string
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
  /** `order-line`, for file names */
  file: string
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
}

export interface Context {
  orm: TsOrm
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
}

/** The TypeScript type of a database value as the drivers return it: exact decimals and dates without a time
 * stay text, so nothing is rounded or moved to another time zone. */
export function tsType(type: DbType): string {
  switch (type.kind) {
    case 'integer':
    case 'float':
      return 'number'
    case 'decimal':
    case 'text':
    case 'enum':
    case 'date':
    case 'time':
    case 'uuid':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'datetime':
      return 'Date'
    case 'binary':
      return 'Buffer'
    case 'array':
      return `${tsType(type.items)}[]`
    case 'json':
    case 'unknown':
      return 'unknown'
  }
}

/** The type of a column, `| null` when it is nullable (or `optional` says so). */
export function columnType(info: ColumnInfo, optional = info.column.nullable): string {
  return optional ? `${info.ts} | null` : info.ts
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

function columnInfo(column: DbColumn): ColumnInfo {
  const generated = column.generated !== undefined && column.generated !== 'onUpdateNow'
  return {
    column,
    prop: memberName(column.name),
    ts: tsType(column.type),
    generated,
    required: !column.nullable && column.default === undefined && !generated,
  }
}

function tableInfo(schema: DbSchema, design: CrudDesign, settings: ProjectSettings, table: DbTable): TableInfo {
  const policy = findPolicy(design, table.name)!
  const repository = findRepository(design, table.name)!
  const service = settings.services ? (findService(design, table.name) ?? null) : null
  const columns = table.columns.map(columnInfo)
  const byName = (name: string) => columns.find((info) => info.column.name === name)!
  // A table without a primary key is mapped on all its columns: ORMs need some key to tell rows apart
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  // The input's classes only count when they are of this stack's ORM
  const ownEntities = !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  return {
    table,
    name: table.name,
    entity: typeName(repository.entity),
    file: fileName(repository.entity),
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
  }
}

export function createContext(orm: TsOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings): Context {
  return { orm, schema, design, settings, tables: schema.tables.map((table) => tableInfo(schema, design, settings, table)) }
}

export const writesEntities = (context: Context) => context.tables.some((info) => info.writesEntity)

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

export const columnOf = (info: TableInfo, name: string) => info.columns.find((column) => column.column.name === name)!

// Modules and names

/** Module path (without extension) of one kind of file of a table: `src/repositories/order-line` or `src/order-line/repository`. */
export function moduleOf(context: Context, info: TableInfo, kind: 'entity' | 'repository' | 'service' | 'dtos'): string {
  // Entities the project does not write are imported from the module the settings name (dots become slashes);
  // plain entities are always written: the setting decides on the ORM's own tables
  if (kind === 'entity' && !info.writesEntity && !context.orm.plainEntities) return context.settings.entitiesModule.replace(/\./g, '/')
  if (context.settings.architecture === 'table') return `src/${info.file}/${kind}`
  const folder = { entity: 'entities', repository: 'repositories', service: 'services', dtos: 'dtos' }[kind]
  return `src/${folder}/${info.file}`
}

export const pathOf = (module: string) => `${module}.ts`

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

/** TypeScript name of a repository query: the neutral name, with the verb the settings choose for single reads. */
export function queryName(context: Context, query: QueryDesign): string {
  if (query.kind === 'getByKey' || query.kind === 'findByUnique') return readName(context, query.name, false)
  return query.name
}

export function operationName(context: Context, operation: OperationDesign): string {
  if (operation.kind === 'get') return readName(context, operation.name, true)
  if (operation.kind === 'find') return readName(context, operation.name, false)
  return operation.name
}

export const repositoryInterface = (info: TableInfo) => `${info.entity}Repository`
export const sqlRepositoryClass = (info: TableInfo) => `Sql${info.entity}Repository`
export const memoryRepositoryClass = (info: TableInfo) => `Memory${info.entity}Repository`
export const serviceClass = (info: TableInfo) => `${info.entity}Service`

export function query(info: TableInfo, kind: QueryDesign['kind'], columns?: string[]): QueryDesign | undefined {
  return info.queries.find((item) => item.kind === kind && (!columns || item.columns.join(',') === columns.join(',')))
}
