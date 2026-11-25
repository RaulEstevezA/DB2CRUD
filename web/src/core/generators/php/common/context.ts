/**
 * What every file of a PHP project needs to know about each table, computed once: the names of its classes,
 * properties and namespaces, its columns with their PHP types, its key, the decisions of the review and the queries
 * and operations that are on. Mirrors the C# context (csharp/context.ts).
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
import type { DbColumn, DbSchema, DbTable } from '../../../schema/types.ts'
import type { ProjectSettings } from '../../../settings/settings.ts'
import type { PhpOrm } from './orm.ts'
import { fieldName, nullable, pascalName } from './php.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Property of the entity: `passwordHash` (Doctrine) or `password_hash` (Eloquent) */
  prop: string
  /** Name of the field in DTOs, of the value in services, and of a variable: `passwordHash` */
  field: string
  /** PHP type without null: `int`, `string`, `\DateTimeImmutable` */
  php: string
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
  orm: PhpOrm
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
  /** The root namespace: `App` */
  base: string
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

const DATES = new Set(['date', 'time', 'datetime'])

/** Whether a column is a date in the key of its table, or points to one (through other tables too). */
function isDateKey(schema: DbSchema, table: DbTable, name: string, seen: Set<string> = new Set()): boolean {
  const column = table.columns.find((item) => item.name === name)
  if (!column || !DATES.has(column.type.kind)) return false
  if (table.primaryKey?.includes(name)) return true
  const id = `${table.name}.${name}`
  if (seen.has(id)) return false
  seen.add(id)
  return table.foreignKeys.some((key) => {
    const position = key.columns.indexOf(name)
    const parent = position >= 0 ? schema.tables.find((item) => item.name === key.references.table) : undefined
    return parent !== undefined && isDateKey(schema, parent, key.references.columns[position], seen)
  })
}

function columnInfo(orm: PhpOrm, schema: DbSchema, table: DbTable, column: DbColumn): ColumnInfo {
  const generated = column.generated !== undefined && column.generated !== 'onUpdateNow'
  // MongoDB's `_id` is the `id` of the entity, unless the documents have one of their own
  const own = orm.documents && column.name === '_id' && table.columns.some((item) => item.name === 'id')
  return {
    column,
    prop: own ? 'documentId' : orm.property(column),
    field: own ? 'documentId' : fieldName(column.name),
    php: orm.textDateKeys && isDateKey(schema, table, column.name) ? 'string' : orm.phpType(column.type),
    generated,
    required: !column.nullable && column.default === undefined && !generated,
  }
}

function tableInfo(orm: PhpOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings, table: DbTable): TableInfo {
  const policy = findPolicy(design, table.name)!
  const repository = findRepository(design, table.name)!
  const service = settings.services ? (findService(design, table.name) ?? null) : null
  const entity = pascalName(repository.entity)
  const columns = table.columns.map((column) => columnInfo(orm, schema, table, column))
  const byName = (name: string) => columns.find((info) => info.column.name === name)!
  // A table without a primary key is read only; its rows are told apart by all their columns
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const ownEntities = !orm.documents && !repository.entityMissing && schema.source.format === settings.orm
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && !ownEntities)
  const folder = pascalName(table.name)
  return {
    table,
    name: table.name,
    entity,
    folder: folder === entity ? `${folder}Table` : folder,
    attr: fieldName(table.name),
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

export function createContext(orm: PhpOrm, schema: DbSchema, design: CrudDesign, settings: ProjectSettings): Context {
  return {
    orm,
    schema,
    design,
    settings,
    tables: schema.tables.map((table) => tableInfo(orm, schema, design, settings, table)),
    base: 'App',
  }
}

export const writesEntities = (context: Context) => context.tables.some((info) => info.writesEntity)

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

export const columnOf = (info: TableInfo, name: string) => info.columns.find((column) => column.column.name === name)!

/** The type of a property that may be null. */
export const optionalType = (column: ColumnInfo) => nullable(column.php)

/** The type of a value that is stored: null only when the column takes null. */
export const storedType = (column: ColumnInfo) => (column.column.nullable ? nullable(column.php) : column.php)

// Namespaces and names

export type Kind = 'entity' | 'repository' | 'service' | 'dtos'

/** `app.entities` → `App\Entities`: the namespace the entities are imported from when none are written. */
const moduleNamespace = (module: string) => module.split('.').map(pascalName).join('\\')

/** The namespace of one kind of class of a table: `App\Repositories` or `App\Tables\OrderLines`. */
export function namespaceOf(context: Context, info: TableInfo, kind: Kind): string {
  if (kind === 'entity' && !info.writesEntity) return moduleNamespace(context.settings.entitiesModule)
  if (context.settings.architecture === 'table') return `${context.base}\\Tables\\${info.folder}`
  return `${context.base}\\${{ entity: 'Entities', repository: 'Repositories', service: 'Services', dtos: 'Dtos' }[kind]}`
}

/** The full name of a class: `App\Entities\Customer`. */
export const className = (ns: string, name: string) => `${ns}\\${name}`

/** The file of a class, by PSR-4: `App\Tables\OrderLines` → `src/Tables/OrderLines/<name>.php`. */
export function pathOf(ns: string, name: string): string {
  const parts = ns.split('\\')
  return ['src', ...parts.slice(1), `${name}.php`].join('/')
}

export const errorsNamespace = (context: Context) => `${context.base}\\Errors`
export const commonNamespace = (context: Context) => `${context.base}\\Common`
export const errorClass = (context: Context, name: string) => className(errorsNamespace(context), name)
export const commonClass = (context: Context, name: string) => className(commonNamespace(context), name)
export const rootClass = (context: Context, name: string) => className(context.base, name)

function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return neutral.replace(/^(get|find)(?=[A-Z])/, verb)
}

/** `findById`: the PHP name of a repository query. */
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

/** The file of a PHP class: the opening tag, strict types, the namespace, its uses and its body. */
export function phpFile(
  path: string,
  ns: string,
  uses: string,
  body: (string | false | null | undefined)[],
): { path: string; content: string } {
  const content = ['<?php', '', 'declare(strict_types=1);', '', `namespace ${ns};`, '', ...(uses !== '' ? [uses, ''] : []), ...body, '']
  return { path, content: content.filter((line): line is string => typeof line === 'string').join('\n') }
}
