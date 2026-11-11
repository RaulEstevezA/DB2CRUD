/**
 * Shared context of the Ktor generator: the package of each class for the chosen architecture (Strategy
 * pattern: `layered` packages by layer, `modular` by resource), and the names of each resource's classes,
 * properties and table.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { ktClass, ktName, ktPackage, type KtTypeNames } from '../../languages/kotlin/kotlin.ts'

export type ClassKind = 'model' | 'dto' | 'repository' | 'service' | 'routes'

export interface Layout {
  /** Package of a resource's class of this kind */
  resource(resource: SpecResource, kind: ClassKind): string
  /** Package of the enums and embedded objects */
  shared(): string
}

export interface KtorContext {
  spec: ApiSpec
  settings: ProjectSettings
  base: string
  layout: Layout
  exposed: boolean
  pending: boolean
  security: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): KtorContext {
  const base = settings.javaPackage
  const layered: Layout = {
    resource: (_resource, kind) => `${base}.${kind}`,
    shared: () => `${base}.model`,
  }
  const modular: Layout = {
    resource: (resource) => `${base}.${ktClass(resource.name).toLowerCase()}`,
    shared: () => `${base}.shared`,
  }
  return {
    spec,
    settings,
    base,
    layout: settings.architecture === 'modular' ? modular : layered,
    exposed: settings.persistence === 'exposed',
    pending: settings.persistence === 'none',
    security: settings.auth !== 'none',
  }
}

/** Path of a Kotlin source file from its package and class. */
export function sourcePath(pkg: string, name: string, test = false): string {
  return `src/${test ? 'test' : 'main'}/kotlin/${pkg.replace(/\./g, '/')}/${name}.kt`
}

/** The package of what every resource shares: errors, lists, request bodies, JSON helpers, settings. */
export function commonPackage(context: KtorContext): string {
  return `${context.base}.common`
}

/** Fully qualified names of the shared classes and of the project's helpers. */
export function typeNames(context: KtorContext): KtTypeNames {
  return {
    shared: (name) => `${context.layout.shared()}.${ktClass(name)}`,
    common: (name) => `${commonPackage(context)}.${name}`,
  }
}

/** Names of a resource's classes and table. */
export function names(resource: SpecResource) {
  const type = ktClass(resource.name)
  return {
    type,
    create: `${type}Create`,
    update: `${type}Update`,
    response: `${type}Response`,
    repository: `${type}Repository`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    exposedRepository: `Exposed${type}Repository`,
    table: `${type}Table`,
    service: `${type}Service`,
    routes: `${type}Routes`,
    routesFunction: `${ktName(resource.name).replace(/`/g, '')}Routes`,
    one: ktName(resource.name).replace(/`/g, ''),
    sqlTable: resource.plural.replace(/ /g, '_').toLowerCase(),
  }
}

/** The Kotlin property of a field: its JSON name in camelCase. */
export function property(field: SpecField): string {
  return ktName(field.wire)
}

/** The column of a field: its JSON name in snake_case. */
export function column(field: SpecField): string {
  return field.wire
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

/** The Kotlin type of the key: whole numbers are always `Long`. */
export function keyType(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return 'Long'
  if (resource.key.type.scalar === 'uuid') return 'JsonUuid'
  return 'String'
}

/** The package path of a fully qualified name, with keywords escaped, for a `package` line. */
export function packageLine(pkg: string): string {
  return ktPackage(pkg)
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
