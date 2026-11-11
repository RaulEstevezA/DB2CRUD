/**
 * Shared context of the Axum generator: the module of each type for the chosen architecture (Strategy pattern:
 * `layered` groups modules by kind, `modular` keeps one module per resource), and the names of each resource's
 * types, fields and table.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { rsModule, rsName, rsPascal, rsType, type RsTypeNames } from '../../languages/rust/rust.ts'

export type ModuleKind = 'model' | 'dto' | 'repository' | 'entity' | 'service' | 'routes'

/** The folder of each kind in the layered layout. */
const LAYERED: Record<ModuleKind, string> = {
  model: 'models',
  dto: 'dtos',
  repository: 'repositories',
  entity: 'entities',
  service: 'services',
  routes: 'routes',
}

export interface Layout {
  /** Module path of a resource's module of this kind, from the crate root: `models::customer` */
  resource(resource: SpecResource, kind: ModuleKind): string
  /** Module path of an enum or embedded object */
  shared(name: string): string
}

const layered: Layout = {
  resource: (resource, kind) => `${LAYERED[kind]}::${rsModule(resource.name)}`,
  shared: (name) => `models::${rsModule(name)}`,
}

/** Modules of the crate root a resource module cannot take in the modular layout. */
const ROOT_MODULES = new Set(['common', 'shared', 'database', 'security', 'main', 'lib'])

/** The module of a resource in the modular layout: its name, unless the crate root already uses it. */
export function resourceModule(resource: SpecResource): string {
  const module = rsModule(resource.name)
  return ROOT_MODULES.has(module) ? `${module}_resource` : module
}

const modular: Layout = {
  resource: (resource, kind) => `${resourceModule(resource)}::${kind}`,
  shared: (name) => `shared::${rsModule(name)}`,
}

export interface AxumContext {
  spec: ApiSpec
  settings: ProjectSettings
  /** Name of the Cargo package: the project name, made valid for Cargo */
  package: string
  /** Name of the library crate: `shop-api` → `shop_api` */
  crate: string
  layout: Layout
  seaOrm: boolean
  pending: boolean
  security: boolean
}

/** Package names Cargo refuses or that would hide a crate of the standard library. */
const RESERVED_PACKAGES = new Set(['std', 'core', 'alloc', 'test', 'proc-macro', 'self', 'crate', 'super'])

/** A Cargo package name from the project name: never starting with a digit, never a reserved name. */
export function packageName(name: string): string {
  if (!name || /^[0-9]/.test(name)) return `api-${name || 'project'}`
  return RESERVED_PACKAGES.has(name) ? `${name}-api` : name
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): AxumContext {
  const pkg = packageName(settings.name)
  return {
    spec,
    settings,
    package: pkg,
    crate: pkg.replace(/-/g, '_'),
    layout: settings.architecture === 'modular' ? modular : layered,
    seaOrm: settings.persistence === 'seaOrm',
    pending: settings.persistence === 'none',
    security: settings.auth !== 'none',
  }
}

/** Path of the source file of a module path. */
export function modulePath(module: string): string {
  return `src/${module.replace(/::/g, '/')}.rs`
}

/** Where the enums and embedded objects live, as `use` paths. */
export function typeNames(context: AxumContext): RsTypeNames {
  return { shared: (name) => `crate::${context.layout.shared(name)}::${rsType(name)}` }
}

/** Names of a resource's types and table. */
export function names(resource: SpecResource) {
  const type = rsType(resource.name)
  const plural = resource.plural.replace(/ /g, '_')
  return {
    type,
    create: `${type}Create`,
    update: `${type}Update`,
    response: `${type}Response`,
    filters: `${type}Filters`,
    repository: `${type}Repository`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    seaOrmRepository: `SeaOrm${type}Repository`,
    service: `${type}Service`,
    /** The field of the application state that holds the service */
    state: rsModule(plural),
    module: rsModule(resource.name),
    table: plural.toLowerCase(),
    test: `${rsModule(resource.name)}_api`,
    one: rsModule(resource.name),
    plural: rsPascal(plural),
  }
}

/** The Rust field of a property: its JSON name in snake_case. */
export function field(property: SpecField): string {
  return rsName(property.wire)
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((item) => item.name === resource.key.field)!
}

/** The Rust type of the key: whole numbers are always `i64`. */
export function keyType(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return 'i64'
  if (resource.key.type.scalar === 'uuid') return 'Uuid'
  return 'String'
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
