/**
 * Shared context of the ASP.NET Core generator: the namespace and folder of each class for the chosen
 * architecture (Strategy pattern: `layered` groups classes by kind, `modular` keeps one folder per resource
 * under Features/), and the names of each resource's classes and properties.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { csClass, csPascal, csProperty, type CsTypeNames } from '../../languages/csharp/csharp.ts'

export type ClassKind = 'model' | 'dto' | 'repository' | 'service' | 'controller'

export interface Layout {
  /** Namespace of a resource's class of this kind, relative to the root namespace */
  resource(resource: SpecResource, kind: ClassKind): string
  /** Namespace of the enums and embedded objects, relative to the root namespace */
  shared(): string
}

const LAYERED: Record<ClassKind, string> = {
  model: 'Models',
  dto: 'Dtos',
  repository: 'Repositories',
  service: 'Services',
  controller: 'Controllers',
}

const layered: Layout = {
  resource: (_resource, kind) => LAYERED[kind],
  shared: () => 'Models',
}

const modular: Layout = {
  resource: (resource) => `Features.${featureName(resource)}`,
  shared: () => 'Shared',
}

/** The folder of a resource in the modular layout: its plural in PascalCase, never its class name. */
function featureName(resource: SpecResource): string {
  const plural = csPascal(resource.plural.replace(/ /g, '_'))
  return plural === csClass(resource.name) ? `${plural}Feature` : plural
}

export interface AspNetContext {
  spec: ApiSpec
  settings: ProjectSettings
  /** Root namespace and project name: `shop-api` → `ShopApi` */
  root: string
  layout: Layout
  efCore: boolean
  pending: boolean
  security: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): AspNetContext {
  return {
    spec,
    settings,
    root: csPascal(settings.name),
    layout: settings.architecture === 'modular' ? modular : layered,
    efCore: settings.persistence === 'efCore',
    pending: settings.persistence === 'none',
    security: settings.auth !== 'none',
  }
}

/** The full namespace of a namespace relative to the root. */
export function namespaceOf(context: AspNetContext, relative: string): string {
  return `${context.root}.${relative}`
}

/** Path of a source file of the application from its relative namespace and class. */
export function sourcePath(context: AspNetContext, relative: string, name: string): string {
  return `src/${context.root}/${relative.replace(/\./g, '/')}/${name}.cs`
}

/** Path of a source file of the test project. */
export function testPath(context: AspNetContext, name: string): string {
  return `tests/${context.root}.Tests/${name}.cs`
}

/** Names of a resource's classes. */
export function names(resource: SpecResource) {
  const type = csClass(resource.name)
  return {
    type,
    create: `${type}Create`,
    update: `${type}Update`,
    response: `${type}Response`,
    repository: `I${type}Repository`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    efRepository: `Ef${type}Repository`,
    service: `${type}Service`,
    controller: `${csPascal(resource.plural.replace(/ /g, '_'))}Controller`,
    set: csPascal(resource.plural.replace(/ /g, '_')),
    table: resource.plural.replace(/ /g, '_'),
  }
}

/** The C# property of a field in a class: its JSON name in PascalCase. */
export function property(field: SpecField, owner: string): string {
  return csProperty(field.wire, owner)
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

/** The C# type of the key: whole numbers are always `long`. */
export function keyType(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return 'long'
  if (resource.key.type.scalar === 'uuid') return 'Guid'
  return 'string'
}

/** Where the enums and embedded objects live. */
export function sharedNames(context: AspNetContext): CsTypeNames {
  return { namespace: () => namespaceOf(context, context.layout.shared()) }
}

/** The namespace of what every resource shares: errors, lists, request bodies, JSON helpers. */
export function commonNamespace(context: AspNetContext): string {
  return namespaceOf(context, 'Common')
}

/** The namespace of the database context (Entity Framework Core). */
export function dataNamespace(context: AspNetContext): string {
  return namespaceOf(context, 'Data')
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
