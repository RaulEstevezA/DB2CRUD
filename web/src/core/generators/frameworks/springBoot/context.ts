/**
 * Shared context of the Spring Boot generator: the package of each class for the chosen architecture
 * (Strategy pattern: `layered` packages by layer, `modular` by resource), and the names of each resource's
 * classes and properties.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { javaClass, javaName, type JavaTypeNames } from '../../languages/java/java.ts'

export type ClassKind = 'model' | 'dto' | 'repository' | 'service' | 'controller'

export interface Layout {
  /** Package of a resource's class of this kind */
  resource(resource: SpecResource, kind: ClassKind): string
  /** Package of the enums and embedded objects */
  shared(): string
}

export interface SpringContext {
  spec: ApiSpec
  settings: ProjectSettings
  base: string
  layout: Layout
  jpa: boolean
  pending: boolean
  security: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): SpringContext {
  const base = settings.javaPackage
  const layered: Layout = {
    resource: (_resource, kind) => `${base}.${kind}`,
    shared: () => `${base}.model`,
  }
  const modular: Layout = {
    resource: (resource) => `${base}.${javaName(resource.name).toLowerCase()}`,
    shared: () => `${base}.shared`,
  }
  return {
    spec,
    settings,
    base,
    layout: settings.architecture === 'modular' ? modular : layered,
    jpa: settings.persistence === 'jpa',
    pending: settings.persistence === 'none',
    security: settings.auth !== 'none',
  }
}

/** Path of a Java source file from its package and class. */
export function sourcePath(pkg: string, name: string, test = false): string {
  return `src/${test ? 'test' : 'main'}/java/${pkg.replace(/\./g, '/')}/${name}.java`
}

/** Names of a resource's classes. */
export function names(resource: SpecResource) {
  const type = javaClass(resource.name)
  return {
    type,
    create: `${type}Create`,
    update: `${type}Update`,
    response: `${type}Response`,
    repository: `${type}Repository`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    jpaRepository: `Jpa${type}Repository`,
    springData: `${type}JpaRepository`,
    service: `${type}Service`,
    controller: `${type}Controller`,
    one: javaName(resource.name),
  }
}

/** The Java property of a field: its JSON name in camelCase. */
export function property(field: SpecField): string {
  return javaName(field.wire)
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

/** The Java type of the key: whole numbers are always `Long`. */
export function keyType(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return 'Long'
  if (resource.key.type.scalar === 'uuid') return 'UUID'
  return 'String'
}

/** Qualified names of enums and embedded objects. */
export function sharedNames(context: SpringContext): JavaTypeNames {
  return {
    object: (name) => `${context.layout.shared()}.${javaClass(name)}`,
    enum: (name) => `${context.layout.shared()}.${javaClass(name)}`,
  }
}

/** The common package: errors, lists and the presence-tracking base of request bodies. */
export function commonPackage(context: SpringContext): string {
  return `${context.base}.common`
}
