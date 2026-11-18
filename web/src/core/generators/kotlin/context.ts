/**
 * What every file of a Kotlin project needs to know about each table, computed once: the names of its classes,
 * properties and packages, its columns with their Kotlin types, its key, the decisions of the review and the queries
 * and operations that are on. Mirrors the PHP context (php/common/context.ts).
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
import { toCamelCase } from '../../model/naming.ts'
import { memberName, typeName } from './kotlin.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Property of the entity, the table and the DTOs: `passwordHash` (between backticks when it is a keyword) */
  prop: string
  /** The name as text, for the values of a service: `passwordHash` */
  key: string
  /** Kotlin type of the value, without `?`: `Long`, `BigDecimal` */
  kt: string
  /** What to import for the type, when it needs it */
  ktImport: string | null
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
  /** The Exposed table object: `CustomerTable` */
  tableObject: string
  /** `orderlines`, the package of the table when the code is by table */
  pkg: string
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
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
  /** The base package: `app` */
  base: string
}

/** The Kotlin type of a database value, and what to import for it. */
export function ktType(type: DbType): { kt: string; ktImport: string | null } {
  switch (type.kind) {
    case 'integer':
      return { kt: type.bits === 16 ? 'Short' : type.bits === 64 ? 'Long' : 'Int', ktImport: null }
    case 'decimal':
      return { kt: 'BigDecimal', ktImport: 'java.math.BigDecimal' }
    case 'float':
      return { kt: type.bits === 32 ? 'Float' : 'Double', ktImport: null }
    case 'boolean':
      return { kt: 'Boolean', ktImport: null }
    case 'date':
      return { kt: 'LocalDate', ktImport: 'java.time.LocalDate' }
    case 'time':
      return { kt: 'LocalTime', ktImport: 'java.time.LocalTime' }
    case 'datetime':
      return type.timezone
        ? { kt: 'OffsetDateTime', ktImport: 'java.time.OffsetDateTime' }
        : { kt: 'LocalDateTime', ktImport: 'java.time.LocalDateTime' }
    case 'uuid':
      return { kt: 'UUID', ktImport: 'java.util.UUID' }
    case 'binary':
      return { kt: 'ByteArray', ktImport: null }
    // JSON (and arrays, kept as JSON) as its text; enums as their value; unknown types as their text
    case 'json':
    case 'array':
    case 'text':
    case 'enum':
    case 'unknown':
      return { kt: 'String', ktImport: null }
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
  return {
    column,
    prop: memberName(column.name),
    key: toCamelCase(column.name) || 'value',
    ...ktType(column.type),
    generated,
    required: !column.nullable && column.default === undefined && !generated,
  }
}

function tableInfo(schema: DbSchema, design: CrudDesign, settings: ProjectSettings, table: DbTable): TableInfo {
  const policy = findPolicy(design, table.name)!
  const repository = findRepository(design, table.name)!
  const service = settings.services ? (findService(design, table.name) ?? null) : null
  const entity = typeName(repository.entity)
  const columns = table.columns.map(columnInfo)
  const byName = (name: string) => columns.find((info) => info.column.name === name)!
  // A table without a primary key is read only; its rows are told apart by all their columns
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const ownEntities = !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  return {
    table,
    name: table.name,
    entity,
    tableObject: `${entity}Table`,
    pkg: table.name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'table',
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

/** The type of a property that may be null. */
export const optionalType = (column: ColumnInfo) => `${column.kt}?`

/** The type of a value that is stored: `?` only when the column takes null. */
export const storedType = (column: ColumnInfo) => (column.column.nullable ? `${column.kt}?` : column.kt)

/** The value of a property known to be set: `entity.email!!`, or as it is when the column takes null. */
export const stored = (expression: string, column: ColumnInfo) => (column.column.nullable ? expression : `${expression}!!`)

// Packages and names

export type Kind = 'entity' | 'repository' | 'service' | 'dtos'

/** The package of one kind of class of a table: `app.repositories` or `app.orderlines`. */
export function packageOf(context: Context, info: TableInfo, kind: Kind): string {
  if (kind === 'entity' && !info.writesEntity) return context.settings.entitiesModule
  if (context.settings.architecture === 'table') return `${context.base}.${info.pkg}`
  return `${context.base}.${{ entity: 'entities', repository: 'repositories', service: 'services', dtos: 'dtos' }[kind]}`
}

export const qualified = (pkg: string, name: string) => `${pkg}.${name}`

/** The file of a class: `app.orderlines` → `src/main/kotlin/app/orderlines/<name>.kt`. */
export function pathOf(pkg: string, name: string, test = false): string {
  return [`src/${test ? 'test' : 'main'}/kotlin`, ...pkg.split('.'), `${name}.kt`].join('/')
}

export const errorsPackage = (context: Context) => `${context.base}.errors`
export const commonPackage = (context: Context) => `${context.base}.common`

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

/** `findById`: the Kotlin name of a repository query. */
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

/** The type a repository is used through: its interface, or the database class when there are none. */
export const repositoryType = (context: Context, info: TableInfo) =>
  context.settings.repositoryInterfaces ? repositoryInterface(info) : sqlRepositoryClass(info)

/** The file of a Kotlin class: its package, imports and body. */
export function ktFile(
  path: string,
  pkg: string,
  imports: string,
  body: (string | false | null | undefined)[],
): { path: string; content: string } {
  const content = [`package ${pkg}`, '', ...(imports !== '' ? [imports, ''] : []), ...body, '']
  return { path, content: content.filter((line): line is string => typeof line === 'string').join('\n') }
}

/** Indents the lines that apply. */
export const ind = <T>(items: (string | T)[], spaces = 4): (string | T)[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))
