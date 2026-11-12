/**
 * What every file of a Java project needs to know about each table, computed once: the names of its classes,
 * properties and packages, its columns with their Java types, its key, the decisions of the review and the queries
 * and operations that are on. Mirrors the TypeScript context (typescript/common/context.ts).
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
import { capitalized, memberName, packageName, typeName } from './java.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Property of the entity: the column name in camelCase */
  prop: string
  /** Java type of the value, boxed: `Long`, `BigDecimal` */
  java: string
  /** Fully qualified name to import for the type, when it needs one */
  javaImport: string | null
  getter: string
  setter: string
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
  /** `orderline`, the package of the table when the code is by table */
  pkg: string
  /** Accessor of the unit of work: `orderLines` */
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
  /** The base package: `app` */
  base: string
}

/** The Java type of a database value, and what to import for it. */
export function javaType(type: DbType): { java: string; javaImport: string | null } {
  switch (type.kind) {
    case 'integer':
      return { java: type.bits === 16 ? 'Short' : type.bits === 64 ? 'Long' : 'Integer', javaImport: null }
    case 'decimal':
      return { java: 'BigDecimal', javaImport: 'java.math.BigDecimal' }
    case 'float':
      return { java: type.bits === 32 ? 'Float' : 'Double', javaImport: null }
    case 'boolean':
      return { java: 'Boolean', javaImport: null }
    case 'date':
      return { java: 'LocalDate', javaImport: 'java.time.LocalDate' }
    case 'time':
      return type.timezone
        ? { java: 'OffsetTime', javaImport: 'java.time.OffsetTime' }
        : { java: 'LocalTime', javaImport: 'java.time.LocalTime' }
    case 'datetime':
      return type.timezone
        ? { java: 'OffsetDateTime', javaImport: 'java.time.OffsetDateTime' }
        : { java: 'LocalDateTime', javaImport: 'java.time.LocalDateTime' }
    case 'uuid':
      return { java: 'UUID', javaImport: 'java.util.UUID' }
    case 'binary':
      return { java: 'byte[]', javaImport: null }
    // JSON (and arrays, kept as JSON) as its text; enums as their value
    case 'json':
    case 'array':
    case 'text':
    case 'enum':
    case 'unknown':
      return { java: 'String', javaImport: null }
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

function columnInfo(column: DbColumn): ColumnInfo {
  const generated = column.generated !== undefined && column.generated !== 'onUpdateNow'
  const prop = memberName(column.name)
  return {
    column,
    prop,
    ...javaType(column.type),
    getter: `get${capitalized(prop)}`,
    setter: `set${capitalized(prop)}`,
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
  // A table without a primary key is mapped on all its columns: JPA needs an identifier
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const ownEntities = !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  const entity = typeName(repository.entity)
  return {
    table,
    name: table.name,
    entity,
    pkg: packageName(repository.entity),
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

export function createContext(schema: DbSchema, design: CrudDesign, settings: ProjectSettings): Context {
  return { schema, design, settings, tables: schema.tables.map((table) => tableInfo(schema, design, settings, table)), base: 'app' }
}

export const writesEntities = (context: Context) => context.tables.some((info) => info.writesEntity)

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

export const columnOf = (info: TableInfo, name: string) => info.columns.find((column) => column.column.name === name)!

// Packages and names

export type Kind = 'entity' | 'repository' | 'service' | 'dtos'

/** The package of one kind of class of a table: `app.repositories` or `app.orderline`. */
export function packageOf(context: Context, info: TableInfo, kind: Kind): string {
  if (kind === 'entity' && !info.writesEntity) return context.settings.entitiesModule
  if (context.settings.architecture === 'table') return `${context.base}.${info.pkg}`
  return `${context.base}.${{ entity: 'entities', repository: 'repositories', service: 'services', dtos: 'dtos' }[kind]}`
}

/** `app.entities.Product` */
export const qualified = (context: Context, info: TableInfo, kind: Kind, name: string) => `${packageOf(context, info, kind)}.${name}`

/** Packages of what every project shares */
export const errorsPackage = (context: Context) => `${context.base}.errors`
export const commonPackage = (context: Context) => `${context.base}.common`

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

export function queryName(context: Context, query: QueryDesign): string {
  if (query.kind === 'getByKey' || query.kind === 'findByUnique') return readName(context, query.name, false)
  return query.name
}

export function operationName(context: Context, operation: OperationDesign): string {
  if (operation.kind === 'get') return readName(context, operation.name, true)
  if (operation.kind === 'find') return readName(context, operation.name, false)
  return operation.name
}

const JPQL_RESERVED = new Set(
  (
    'ABS ALL AND ANY AS ASC AVG BETWEEN BIT_LENGTH BOTH BY CASE CHAR_LENGTH CHARACTER_LENGTH CLASS COALESCE CONCAT COUNT ' +
    'CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DELETE DESC DISTINCT ELSE EMPTY END ENTRY ESCAPE EXISTS FALSE FETCH FROM ' +
    'GROUP HAVING IN INDEX INNER IS JOIN KEY LEADING LEFT LENGTH LIKE LOCATE LOWER MAX MEMBER MIN MOD NEW NOT NULL NULLIF ' +
    'OBJECT OF OR ORDER OUTER POSITION SELECT SET SIZE SOME SQRT SUBSTRING SUM THEN TRAILING TRIM TRUE TYPE UNKNOWN UPDATE ' +
    'UPPER VALUE WHEN WHERE'
  ).split(' '),
)

/** The name of an entity in JPQL: its class, unless JPQL reserves that word (`Order`). */
export const jpqlName = (info: TableInfo) => (JPQL_RESERVED.has(info.entity.toUpperCase()) ? `${info.entity}Entity` : info.entity)

export const repositoryInterface = (info: TableInfo) => `${info.entity}Repository`
export const sqlRepositoryClass = (info: TableInfo) => `Sql${info.entity}Repository`
export const memoryRepositoryClass = (info: TableInfo) => `Memory${info.entity}Repository`
export const serviceClass = (info: TableInfo) => `${info.entity}Service`

export function query(info: TableInfo, kind: QueryDesign['kind'], columns?: string[]): QueryDesign | undefined {
  return info.queries.find((item) => item.kind === kind && (!columns || item.columns.join(',') === columns.join(',')))
}

/** The class a repository is used through: its interface, or the database class when there are none. */
export const repositoryType = (context: Context, info: TableInfo) =>
  context.settings.repositoryInterfaces ? repositoryInterface(info) : sqlRepositoryClass(info)
