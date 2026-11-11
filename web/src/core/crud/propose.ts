/**
 * Proposes the CRUD design of a physical schema (docs/design.md, section 3): the role of each table and
 * the decisions the schema cannot settle, the queries of each repository and the operations of each
 * service. Every proposal carries its confidence and its reasons.
 *
 * Given the previous design, the proposal keeps every choice the user made where it still applies, so the
 * design follows the schema when the input changes without losing the review.
 */
import { decision, reason, sameValue, type Decision } from '../decisions/decision.ts'
import { pluralize, singularize, splitWords, toPascalCase } from '../model/naming.ts'
import { findTable, isUniqueKey, type DbColumn, type DbForeignKey, type DbSchema, type DbTable } from '../schema/types.ts'
import {
  findPolicy,
  findRepository,
  findService,
  type ChildrenPolicy,
  type Concurrency,
  type CrudDesign,
  type DeleteMode,
  type DomainError,
  type OperationCheck,
  type OperationDesign,
  type QueryDesign,
  type RepositoryDesign,
  type ServiceDesign,
  type TablePolicy,
  type TableRole,
} from './types.ts'

const SOFT_DELETE_COLUMNS = ['deleted_at', 'is_deleted', 'deleted']
const VERSION_COLUMNS = ['version', 'row_version', 'lock_version']
/** Words that name a secret: such columns are never returned unless the user says so. */
const SECRET_WORDS = ['password', 'passwd', 'secret', 'token']

/** Actions that leave the children in place, so deleting the parent fails while they exist. */
const BLOCKING_ACTIONS = new Set([undefined, 'no action', 'restrict'])

/** `deletedAt`, `DeletedAt` and `deleted_at` all give `deleted_at`. */
const snake = (name: string) => splitWords(name).join('_').toLowerCase()

/** `order_lines` → `OrderLine`; the input's class name when it has one. */
export function entityName(table: DbTable): string {
  if (table.entity) return table.entity
  const words = splitWords(table.name)
  if (words.length === 0) return toPascalCase(table.name)
  return toPascalCase([...words.slice(0, -1), singularize(words[words.length - 1])].join(' '))
}

/** `OrderLine` → `OrderLines`. */
function pluralName(entity: string): string {
  const words = splitWords(entity)
  return toPascalCase([...words.slice(0, -1), pluralize(words[words.length - 1])].join(' '))
}

/** `['first_name', 'last_name']` → `FirstNameAndLastName`. */
function byColumns(columns: string[]): string {
  return columns.map((column) => toPascalCase(column)).join('And')
}

/** A new proposal that keeps the user's earlier choice when it is still one of the options. */
function keep<T>(previous: Decision<T> | null | undefined, next: Decision<T>): Decision<T> {
  if (!previous?.manual || !next.options.some((option) => sameValue(option, previous.value))) return next
  return { ...next, value: previous.value, status: 'active', manual: true }
}

const include = (confidence: 'exact' | 'review', reasons: ReturnType<typeof reason>[]) => decision(true, confidence, reasons, [true, false])

// Table decisions

/** A join table: the whole primary key is made of two foreign keys, and there is nothing else. */
function joinParents(table: DbTable): DbForeignKey[] | null {
  const key = table.primaryKey
  if (!key || key.length < 2 || table.columns.length !== key.length || table.foreignKeys.length !== 2) return null
  const covered = table.foreignKeys.flatMap((foreignKey) => foreignKey.columns)
  return covered.length === key.length && key.every((column) => covered.includes(column)) ? table.foreignKeys : null
}

function proposeRole(table: DbTable): Decision<TableRole> {
  if (!table.primaryKey) return decision<TableRole>('readOnly', 'review', [reason('noPrimaryKey')], ['readOnly'])
  const parents = joinParents(table)
  if (parents)
    return decision<TableRole>(
      'join',
      'probable',
      [reason('joinTable', { tables: parents.map((key) => key.references.table).join(', ') })],
      ['join', 'entity'],
    )
  return decision<TableRole>('entity', 'exact', [reason('tableWithKey')], ['entity', 'readOnly'])
}

function proposeDelete(table: DbTable): Decision<DeleteMode> {
  const column = table.columns.find((item) => SOFT_DELETE_COLUMNS.includes(snake(item.name)))
  if (!column) return decision<DeleteMode>({ mode: 'hard' }, 'exact', [reason('noSoftDeleteColumn')], [{ mode: 'hard' }])
  const soft: DeleteMode = { mode: 'soft', column: column.name }
  return decision<DeleteMode>(soft, 'review', [reason('softDeleteColumn', { column: column.name })], [soft, { mode: 'hard' }])
}

function proposeConcurrency(table: DbTable): Decision<Concurrency> {
  const column = table.columns.find((item) => VERSION_COLUMNS.includes(snake(item.name)) && item.type.kind === 'integer')
  if (!column) return decision<Concurrency>({ mode: 'none' }, 'exact', [reason('noVersionColumn')], [{ mode: 'none' }])
  const version: Concurrency = { mode: 'version', column: column.name }
  return decision<Concurrency>(version, 'probable', [reason('versionColumn', { column: column.name })], [version, { mode: 'none' }])
}

/** Tables with a foreign key to this one that declares no action on delete. */
function blockingChildren(schema: DbSchema, table: DbTable): string[] {
  const children: string[] = []
  for (const other of schema.tables)
    for (const key of other.foreignKeys)
      if (
        key.references.table === table.name &&
        (key.references.schema ?? table.schema) === table.schema &&
        BLOCKING_ACTIONS.has(key.onDelete) &&
        !children.includes(other.name)
      )
        children.push(other.name)
  return children
}

function proposeChildren(schema: DbSchema, table: DbTable): Decision<ChildrenPolicy> | null {
  const children = blockingChildren(schema, table)
  if (children.length === 0) return null
  return decision<ChildrenPolicy>(
    'block',
    'review',
    [reason('childrenWithoutAction', { tables: children.join(', ') })],
    ['block', 'deleteFirst'],
  )
}

function isSecret(column: DbColumn): boolean {
  const words = splitWords(column.name).map((word) => word.toLowerCase())
  return words.some((word) => SECRET_WORDS.includes(word)) || words.join(' ').includes('api key')
}

function proposeHidden(table: DbTable): Decision<string[]> {
  const secrets = table.columns.filter(isSecret).map((column) => column.name)
  if (secrets.length === 0) return decision<string[]>([], 'exact', [reason('noSecrets')], [[]])
  return decision(secrets, 'review', [reason('secretNamed', { columns: secrets.join(', ') })], [secrets, []])
}

function proposePolicy(schema: DbSchema, table: DbTable, previous: TablePolicy | undefined): TablePolicy {
  const children = proposeChildren(schema, table)
  return {
    table: table.name,
    role: keep(previous?.role, proposeRole(table)),
    delete: keep(previous?.delete, proposeDelete(table)),
    concurrency: keep(previous?.concurrency, proposeConcurrency(table)),
    children: children ? keep(previous?.children, children) : null,
    hidden: keep(previous?.hidden, proposeHidden(table)),
  }
}

// Repositories

/** Indexes that add a query of their own: not the primary key, a unique constraint or a foreign key again. */
function queryIndexes(table: DbTable) {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((column, index) => column === b[index])
  return table.indexes.filter(
    (index) => !isUniqueKey(table, index.columns) && !table.foreignKeys.some((key) => same(key.columns, index.columns)),
  )
}

function proposeQueries(table: DbTable, role: TableRole, previous: RepositoryDesign | undefined): QueryDesign[] {
  const queries: QueryDesign[] = []
  const add = (query: QueryDesign) => {
    const before = previous?.queries.find((item) => item.id === query.id)
    queries.push({ ...query, include: keep(before?.include, query.include) })
  }
  const key = table.primaryKey
  if (key && role !== 'readOnly')
    add({
      id: 'getByKey',
      kind: 'getByKey',
      name: `getBy${byColumns(key)}`,
      columns: key,
      returns: 'optional',
      include: include('exact', [reason('primaryKey', { columns: key.join(', ') })]),
    })
  add({ id: 'list', kind: 'list', name: 'list', columns: [], returns: 'many', include: include('exact', []) })
  for (const unique of table.uniques)
    add({
      id: `findByUnique:${unique.columns.join(',')}`,
      kind: 'findByUnique',
      name: `findBy${byColumns(unique.columns)}`,
      columns: unique.columns,
      returns: 'optional',
      include: include('exact', [reason('uniqueConstraint', { columns: unique.columns.join(', ') })]),
    })
  for (const foreignKey of table.foreignKeys)
    add({
      id: `listByParent:${foreignKey.columns.join(',')}`,
      kind: 'listByParent',
      name: `listBy${byColumns(foreignKey.columns)}`,
      columns: foreignKey.columns,
      returns: 'many',
      include: include('exact', [reason('foreignKey', { table: foreignKey.references.table })]),
    })
  for (const index of queryIndexes(table))
    add({
      id: `findAllBy:${index.columns.join(',')}`,
      kind: 'findAllBy',
      name: `findAllBy${byColumns(index.columns)}`,
      columns: index.columns,
      returns: 'many',
      include: decision(true, 'review', [reason('indexOnly', { columns: index.columns.join(', ') })], [true, false]),
    })
  if (role !== 'readOnly') {
    const writes = [reason('primaryKey', { columns: (key ?? []).join(', ') })]
    add({ id: 'insert', kind: 'insert', name: 'insert', columns: [], returns: 'one', include: include('exact', writes) })
    if (role === 'entity')
      add({ id: 'update', kind: 'update', name: 'update', columns: [], returns: 'one', include: include('exact', writes) })
    add({ id: 'delete', kind: 'delete', name: 'delete', columns: key ?? [], returns: 'none', include: include('exact', writes) })
  }
  return queries
}

// Services

function proposeOperations(schema: DbSchema, table: DbTable, policy: TablePolicy, previous: ServiceDesign | undefined): OperationDesign[] {
  const role = policy.role.value
  const entity = entityName(table)
  const plural = pluralName(entity)
  const hasUniques = table.uniques.length > 0
  const hasParents = table.foreignKeys.length > 0
  const versioned = policy.concurrency.value.mode === 'version'
  const blocked = policy.children?.value === 'block'
  const operations: OperationDesign[] = []
  const add = (
    id: string,
    kind: OperationDesign['kind'],
    name: string,
    checks: (OperationCheck | false)[],
    errors: (DomainError | false)[],
    extra: Partial<OperationDesign> = {},
    proposal: Decision<boolean> = include('exact', []),
  ) => {
    const before = previous?.operations.find((item) => item.id === id)
    operations.push({
      id,
      kind,
      name,
      columns: [],
      ...extra,
      include: keep(before?.include, proposal),
      checks: checks.filter((check): check is OperationCheck => check !== false),
      errors: errors.filter((error): error is DomainError => error !== false),
    })
  }

  if (role === 'entity') {
    add(
      'create',
      'create',
      `create${entity}`,
      ['validate', hasUniques && 'unique', hasParents && 'parentExists'],
      ['ValidationFailed', hasUniques && 'Conflict'],
    )
    add('get', 'get', `get${entity}`, [], ['NotFound'])
  }
  add('list', 'list', `list${plural}`, [], [])
  if (role === 'entity') {
    add(
      'update',
      'update',
      `update${entity}`,
      ['validate', hasUniques && 'unique', hasParents && 'parentExists', versioned && 'version'],
      ['NotFound', 'ValidationFailed', (hasUniques || versioned) && 'Conflict'],
    )
    add(
      'delete',
      'delete',
      `delete${entity}`,
      [versioned && 'version', blocked && 'children'],
      ['NotFound', (versioned || blocked) && 'Conflict'],
    )
  }
  for (const unique of table.uniques)
    add(`find:${unique.columns.join(',')}`, 'find', `find${entity}By${byColumns(unique.columns)}`, [], [], { columns: unique.columns })
  for (const foreignKey of table.foreignKeys)
    add(`listByParent:${foreignKey.columns.join(',')}`, 'listByParent', `list${plural}By${byColumns(foreignKey.columns)}`, [], [], {
      columns: foreignKey.columns,
    })

  // Links through the join tables that point to this table, when the user keeps them as join tables
  if (role === 'entity')
    for (const other of schema.tables) {
      const parents = joinParents(other)
      if (!parents) continue
      const own = parents.find((key) => key.references.table === table.name)
      const far = parents.find((key) => key !== own)
      if (!own || !far) continue
      const farTable = findTable(schema, far.references.table, far.references.schema)
      if (!farTable) continue
      const farEntity = entityName(farTable)
      const reasons = [reason('joinTable', { tables: parents.map((key) => key.references.table).join(', ') })]
      add(
        `link:${other.name}`,
        'link',
        `add${farEntity}`,
        ['parentExists'],
        ['NotFound', 'Conflict'],
        { through: other.name },
        include('exact', reasons),
      )
      add(`unlink:${other.name}`, 'unlink', `remove${farEntity}`, [], ['NotFound'], { through: other.name }, include('exact', reasons))
    }
  return operations
}

/** The CRUD design of the schema, keeping the user's earlier choices from `previous`. */
export function proposeCrud(schema: DbSchema, previous: CrudDesign | null = null): CrudDesign {
  const policies = schema.tables.map((table) => proposePolicy(schema, table, previous ? findPolicy(previous, table.name) : undefined))
  // A join table only stays one while its role says so: the links of the parents depend on it
  const joins = new Set(policies.filter((policy) => policy.role.value === 'join').map((policy) => policy.table))
  const linkable: DbSchema = { ...schema, tables: schema.tables.filter((other) => !joinParents(other) || joins.has(other.name)) }

  const repositories: RepositoryDesign[] = []
  const services: ServiceDesign[] = []
  schema.tables.forEach((table, index) => {
    const policy = policies[index]
    const role = policy.role.value
    repositories.push({
      table: table.name,
      entity: entityName(table),
      entityMissing: !table.entity,
      queries: proposeQueries(table, role, previous ? findRepository(previous, table.name) : undefined),
    })
    if (role === 'join') return
    services.push({
      table: table.name,
      name: `${entityName(table)}Service`,
      operations: proposeOperations(linkable, table, policy, previous ? findService(previous, table.name) : undefined),
    })
  })
  return { policies, repositories, services }
}
