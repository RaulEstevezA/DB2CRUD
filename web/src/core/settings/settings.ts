/**
 * The settings of a generated project (docs/design.md, section 4): every choice that is a matter of taste
 * or of the project around the code. Every option is foreseen and generated; the defaults are only the
 * recommended ones. A stack offers the options it can honour, and `normalizeSettings` turns any settings
 * into ones the chosen stack supports, so the generators never receive an impossible combination.
 *
 * To support a new stack, add it to `STACKS` with the options its generator implements, and register the
 * generator (generators/registry.ts).
 */
import type { Dialect } from '../schema/types.ts'

export type LanguageId = 'python' | 'typescript' | 'java' | 'csharp'
export type OrmId = 'sqlalchemy' | 'django' | 'typeorm' | 'prisma' | 'drizzle' | 'sequelize' | 'jpa' | 'efcore'

/** Which ORM entities are written: only those the input lacks, all of them (replacing the input's), or none. */
export type EntitiesMode = 'missing' | 'all' | 'none'
/** What services take and return: the entities, or DTOs written per table (create, update, read). */
export type ServiceTypes = 'entities' | 'dtos'
/** Where transactions start and end: one per service operation, the caller's, or one per repository write. */
export type Transactions = 'operation' | 'caller' | 'repository'
export type Execution = 'sync' | 'async'
export type ErrorStyle = 'exceptions' | 'results'
/** How lists are read: all at once, with offset and limit, or with a cursor on the primary key. */
export type Paging = 'none' | 'offset' | 'cursor'
/** By layer (`repositories/`, `services/`) or by table (one folder per table). */
export type Architecture = 'layer' | 'table'
/** `getFind`: `get` for one row that must exist, `find` for optional rows and lists; or one verb for all. */
export type Verbs = 'getFind' | 'get' | 'find'
export type Tests = 'all' | 'services' | 'repositories' | 'none'
/** The kind of class DTOs are written as, per language. */
export type DtoKind = 'pydantic' | 'dataclass' | 'interface' | 'class' | 'record'
/** How a service takes the changes of an update: the language's partial object (TypeScript, Python), or, in typed
 * languages, a Patch<T> per field (absent, null or a value), Optional<T> (null when not sent), or every field. */
export type Updates = 'partial' | 'patch' | 'optional' | 'full'

export interface ProjectSettings {
  /** Name of the generated project, in lowercase words: `shop-data` */
  name: string
  language: LanguageId
  orm: OrmId
  database: Dialect
  entities: EntitiesMode
  /** Python module the entities are imported from when none are written */
  entitiesModule: string
  services: boolean
  serviceTypes: ServiceTypes
  dtoKind: DtoKind
  updates: Updates
  transactions: Transactions
  execution: Execution
  errors: ErrorStyle
  repositoryInterfaces: boolean
  memoryRepositories: boolean
  paging: Paging
  architecture: Architecture
  verbs: Verbs
  tests: Tests
}

export interface StackInfo {
  language: LanguageId
  orm: OrmId
  label: string
  databases: readonly Dialect[]
  execution: readonly Execution[]
  errors: readonly ErrorStyle[]
  dtoKinds: readonly DtoKind[]
  updates: readonly Updates[]
}

/** Every stack a generator writes, in the order the interface shows them. */
export const STACKS: readonly StackInfo[] = [
  {
    language: 'python',
    orm: 'sqlalchemy',
    label: 'SQLAlchemy 2',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    execution: ['sync', 'async'],
    // Python has no common result type: exceptions are its way
    errors: ['exceptions'],
    dtoKinds: ['pydantic', 'dataclass'],
    updates: ['partial'],
  },
  {
    language: 'python',
    orm: 'django',
    label: 'Django 5.2',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    // Django's asynchronous ORM cannot hold a transaction (transaction.atomic is synchronous only)
    execution: ['sync'],
    errors: ['exceptions'],
    dtoKinds: ['pydantic', 'dataclass'],
    updates: ['partial'],
  },
  {
    language: 'typescript',
    orm: 'typeorm',
    label: 'TypeORM 0.3',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    // Every database call in Node returns a promise
    execution: ['async'],
    // TypeScript has no common result type: errors are thrown
    errors: ['exceptions'],
    dtoKinds: ['interface', 'class'],
    updates: ['partial'],
  },
  {
    language: 'typescript',
    orm: 'prisma',
    label: 'Prisma 7',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    execution: ['async'],
    errors: ['exceptions'],
    dtoKinds: ['interface', 'class'],
    updates: ['partial'],
  },
  {
    language: 'typescript',
    orm: 'drizzle',
    label: 'Drizzle 0.45',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    execution: ['async'],
    errors: ['exceptions'],
    dtoKinds: ['interface', 'class'],
    updates: ['partial'],
  },
  {
    language: 'typescript',
    orm: 'sequelize',
    label: 'Sequelize 6',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    execution: ['async'],
    errors: ['exceptions'],
    dtoKinds: ['interface', 'class'],
    updates: ['partial'],
  },
  {
    language: 'java',
    orm: 'jpa',
    label: 'JPA · Hibernate 7',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    // JPA is blocking: an EntityManager has no asynchronous API
    execution: ['sync'],
    errors: ['exceptions'],
    dtoKinds: ['record', 'class'],
    updates: ['patch', 'optional', 'full'],
  },
  {
    language: 'csharp',
    orm: 'efcore',
    label: 'EF Core 9',
    databases: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
    execution: ['async'],
    errors: ['exceptions'],
    dtoKinds: ['record', 'class'],
    // .NET has no Optional<T>: a Patch<T> or every field
    updates: ['patch', 'full'],
  },
]

export const DEFAULT_SETTINGS: ProjectSettings = {
  name: 'data-access',
  language: 'python',
  orm: 'sqlalchemy',
  database: 'postgresql',
  entities: 'missing',
  entitiesModule: 'app.entities',
  services: true,
  serviceTypes: 'entities',
  dtoKind: 'pydantic',
  updates: 'partial',
  transactions: 'operation',
  execution: 'sync',
  errors: 'exceptions',
  repositoryInterfaces: true,
  memoryRepositories: true,
  paging: 'offset',
  architecture: 'layer',
  verbs: 'getFind',
  tests: 'all',
}

const ENTITIES: readonly EntitiesMode[] = ['missing', 'all', 'none']
const SERVICE_TYPES: readonly ServiceTypes[] = ['entities', 'dtos']
const TRANSACTIONS: readonly Transactions[] = ['operation', 'caller', 'repository']
const PAGING: readonly Paging[] = ['none', 'offset', 'cursor']
const ARCHITECTURES: readonly Architecture[] = ['layer', 'table']
const VERBS: readonly Verbs[] = ['getFind', 'get', 'find']
const TESTS: readonly Tests[] = ['all', 'services', 'repositories', 'none']

export function findStack(language: LanguageId, orm: OrmId): StackInfo | undefined {
  return STACKS.find((stack) => stack.language === language && stack.orm === orm)
}

const pick = <T>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback)

/** `Shop Data!` → `shop-data`; empty names fall back to the default. */
export function slug(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return words.length > 0 ? words.join('-') : DEFAULT_SETTINGS.name
}

/** A dotted module path of valid identifiers (`app.entities`), or the default. */
function modulePath(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)
    ? value
    : DEFAULT_SETTINGS.entitiesModule
}

/** Settings the chosen stack supports: unknown values and options it cannot honour fall back to its first one. */
export function normalizeSettings(settings: Partial<ProjectSettings>): ProjectSettings {
  const stack = findStack(settings.language as LanguageId, settings.orm as OrmId) ?? STACKS[0]
  const services = typeof settings.services === 'boolean' ? settings.services : DEFAULT_SETTINGS.services
  const tests = pick(settings.tests, TESTS, DEFAULT_SETTINGS.tests)
  return {
    name: slug(typeof settings.name === 'string' ? settings.name : DEFAULT_SETTINGS.name),
    language: stack.language,
    orm: stack.orm,
    database: pick(settings.database, stack.databases, stack.databases[0]),
    entities: pick(settings.entities, ENTITIES, DEFAULT_SETTINGS.entities),
    entitiesModule: modulePath(settings.entitiesModule),
    services,
    serviceTypes: pick(settings.serviceTypes, SERVICE_TYPES, DEFAULT_SETTINGS.serviceTypes),
    dtoKind: pick(settings.dtoKind, stack.dtoKinds, stack.dtoKinds[0]),
    updates: pick(settings.updates, stack.updates, stack.updates[0]),
    transactions: pick(settings.transactions, TRANSACTIONS, DEFAULT_SETTINGS.transactions),
    execution: pick(settings.execution, stack.execution, stack.execution[0]),
    errors: pick(settings.errors, stack.errors, stack.errors[0]),
    repositoryInterfaces:
      typeof settings.repositoryInterfaces === 'boolean' ? settings.repositoryInterfaces : DEFAULT_SETTINGS.repositoryInterfaces,
    memoryRepositories:
      typeof settings.memoryRepositories === 'boolean' ? settings.memoryRepositories : DEFAULT_SETTINGS.memoryRepositories,
    paging: pick(settings.paging, PAGING, DEFAULT_SETTINGS.paging),
    architecture: pick(settings.architecture, ARCHITECTURES, DEFAULT_SETTINGS.architecture),
    verbs: pick(settings.verbs, VERBS, DEFAULT_SETTINGS.verbs),
    // Without services there is nothing for service tests to call
    tests: !services && tests === 'services' ? 'none' : !services && tests === 'all' ? 'repositories' : tests,
  }
}
