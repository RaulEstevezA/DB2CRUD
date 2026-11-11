/**
 * What every file of a SQLAlchemy project needs to know about each table, computed once: the names of its
 * classes and modules, its columns with their Python and SQLAlchemy types, its key, the decisions of the
 * review and the queries and operations that are on. Files are written from this, never from the raw
 * design, so they cannot disagree.
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
import { className, Imports, methodName, snakeName } from '../python.ts'

export interface ColumnInfo {
  column: DbColumn
  /** Attribute of the entity: the column name, made a valid identifier */
  attr: string
  /** Python type of the value, without `| None` */
  py: string
  /** The client never sends it on create: the database fills it */
  generated: boolean
  /** Required on create: not null, no default, not generated */
  required: boolean
}

/** A foreign key of a child table to this one: its columns and the columns of this table they hold. */
export interface ChildLink {
  table: string
  columns: string[]
  references: string[]
}

export interface TableInfo {
  table: DbTable
  name: string
  entity: string
  /** `order_line` */
  module: string
  /** Attribute of the unit of work and of the fixtures: `order_lines` */
  attr: string
  columns: ColumnInfo[]
  key: ColumnInfo[]
  role: TablePolicy['role']['value']
  soft: ColumnInfo | null
  version: ColumnInfo | null
  hidden: string[]
  /** Tables whose foreign key to this one has no action on delete, with that key's columns */
  children: { policy: ChildrenPolicy; links: ChildLink[] } | null
  queries: QueryDesign[]
  operations: OperationDesign[]
  repository: RepositoryDesign
  service: ServiceDesign | null
  /** The project writes its entity class */
  writesEntity: boolean
}

export interface Context {
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
  tables: TableInfo[]
  async: boolean
}

function pyType(type: DbType, imports?: Imports): string {
  switch (type.kind) {
    case 'integer':
      return 'int'
    case 'decimal':
      imports?.from('decimal', 'Decimal')
      return 'Decimal'
    case 'float':
      return 'float'
    case 'text':
    case 'enum':
      return 'str'
    case 'boolean':
      return 'bool'
    case 'date':
      imports?.from('datetime', 'date')
      return 'date'
    case 'time':
      imports?.from('datetime', 'time')
      return 'time'
    case 'datetime':
      imports?.from('datetime', 'datetime')
      return 'datetime'
    case 'uuid':
      imports?.from('uuid', 'UUID')
      return 'UUID'
    case 'binary':
      return 'bytes'
    case 'array':
      return `list[${pyType(type.items, imports)}]`
    case 'json':
    case 'unknown':
      imports?.from('typing', 'Any')
      return 'Any'
  }
}

/** The Python type of a column, adding its imports. */
export function columnPyType(info: ColumnInfo, imports: Imports, optional = info.column.nullable): string {
  const base = pyType(info.column.type, imports)
  return optional ? `${base} | None` : base
}

const BLOCKING = new Set([undefined, 'no action', 'restrict'])

/** Foreign keys of other tables to this one that leave their rows in place when it is deleted. */
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
    attr: snakeName(column.name),
    py: pyType(column.type),
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
  // A table without a primary key is mapped on all its columns: SQLAlchemy needs some key to map rows
  const key = (table.primaryKey ?? table.columns.map((column) => column.name)).map(byName)
  const deleteMode = policy.delete.value
  const concurrency = policy.concurrency.value
  const writesEntity = settings.entities === 'all' || (settings.entities === 'missing' && repository.entityMissing)
  return {
    table,
    name: table.name,
    entity: className(repository.entity),
    module: snakeName(repository.entity),
    attr: snakeName(table.name),
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
  return {
    schema,
    design,
    settings,
    tables: schema.tables.map((table) => tableInfo(schema, design, settings, table)),
    async: settings.execution === 'async',
  }
}

export function findInfo(context: Context, table: string): TableInfo | undefined {
  return context.tables.find((info) => info.name === table)
}

// Modules and names

/** Module of one kind of file of a table, by architecture: `app.repositories.order_line` or `app.order_line.repository`. */
export function moduleOf(context: Context, info: TableInfo, kind: 'entity' | 'repository' | 'service' | 'dtos'): string {
  if (kind === 'entity' && !info.writesEntity) return context.settings.entitiesModule
  if (context.settings.architecture === 'table') return `app.${info.module}.${kind}`
  const folder = { entity: 'entities', repository: 'repositories', service: 'services', dtos: 'dtos' }[kind]
  return `app.${folder}.${info.module}`
}

/** Path of a module's file: `app/repositories/order_line.py`. */
export const pathOf = (module: string) => `${module.replace(/\./g, '/')}.py`

/** A read that returns one row or none: `find_by_email`, or `get_by_email`, as the settings name them. */
export function readName(context: Context, neutral: string, mustExist: boolean): string {
  const verb = context.settings.verbs === 'getFind' ? (mustExist ? 'get' : 'find') : context.settings.verbs
  return methodName(neutral.replace(/^(get|find)(?=[A-Z])/, verb))
}

/** Python name of a repository query. */
export function queryName(context: Context, query: QueryDesign): string {
  if (query.kind === 'getByKey' || query.kind === 'findByUnique') return readName(context, query.name, false)
  return methodName(query.name)
}

/** Python name of a service operation. */
export function operationName(context: Context, operation: OperationDesign): string {
  if (operation.kind === 'get') return readName(context, operation.name, true)
  if (operation.kind === 'find') return readName(context, operation.name, false)
  return methodName(operation.name)
}

export const repositoryClass = (info: TableInfo) => `${info.entity}Repository`
export const sqlRepositoryClass = (info: TableInfo) => `Sql${info.entity}Repository`
export const memoryRepositoryClass = (info: TableInfo) => `Memory${info.entity}Repository`
export const serviceClass = (info: TableInfo) => `${info.entity}Service`

/** The query of a kind, when it is on. */
export function query(info: TableInfo, kind: QueryDesign['kind'], columns?: string[]): QueryDesign | undefined {
  return info.queries.find((item) => item.kind === kind && (!columns || item.columns.join(',') === columns.join(',')))
}

export const aw = (context: Context) => (context.async ? 'await ' : '')
export const def = (context: Context) => (context.async ? 'async def' : 'def')
