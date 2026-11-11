/**
 * Shared context of the Vapor generator: the folder of each file for the chosen architecture (Strategy pattern:
 * `layered` groups files by kind, `modular` keeps one folder per resource; every file is in the same Swift module,
 * so the folders only order the code), and the names of each resource's types, properties and table.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { toSnakeCase } from '../../../model/naming.ts'
import { swName, swPascal, swType, type SwTypeNames } from '../../languages/swift/swift.ts'

export type FileKind = 'model' | 'dto' | 'repository' | 'database' | 'service' | 'controller'

/** The folder of each kind in the layered layout. */
const LAYERED: Record<FileKind, string> = {
  model: 'Models',
  dto: 'DTOs',
  repository: 'Repositories',
  database: 'Database',
  service: 'Services',
  controller: 'Controllers',
}

/** Folders of the app a resource folder cannot take in the modular layout. */
const APP_FOLDERS = new Set(['Common', 'Shared', 'Database', 'Security'])

export interface Layout {
  /** Folder of a resource's file of this kind, from Sources/App: `Models` or `Customer` */
  resource(resource: SpecResource, kind: FileKind): string
  /** Folder of the enums and embedded objects */
  shared: string
}

const layered: Layout = {
  resource: (_resource, kind) => LAYERED[kind],
  shared: 'Models',
}

/** The folder of a resource in the modular layout: its type name, unless the app already has that folder. */
export function resourceFolder(resource: SpecResource): string {
  const folder = swType(resource.name)
  return APP_FOLDERS.has(folder) ? `${folder}Resource` : folder
}

const modular: Layout = {
  resource: (resource) => resourceFolder(resource),
  shared: 'Shared',
}

export interface VaporContext {
  spec: ApiSpec
  settings: ProjectSettings
  layout: Layout
  fluent: boolean
  pending: boolean
  security: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): VaporContext {
  return {
    spec,
    settings,
    layout: settings.architecture === 'modular' ? modular : layered,
    fluent: settings.persistence === 'fluent',
    pending: settings.persistence === 'none',
    security: settings.auth !== 'none',
  }
}

/** Path of a source file of the app. */
export function sourcePath(folder: string, name: string): string {
  return `Sources/App/${folder}/${name}.swift`
}

/** Enums and embedded objects are named as types of the module. */
export const typeNames: SwTypeNames = { shared: (name) => swType(name) }

/** Names of a resource's types and table. */
export function names(resource: SpecResource) {
  const type = swType(resource.name)
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
    fluentRepository: `Fluent${type}Repository`,
    record: `${type}Record`,
    migration: `${type}Migration`,
    service: `${type}Service`,
    controller: `${type}Controller`,
    table: toSnakeCase(plural) || 'items',
    tests: `${type}APITests`,
    /** The type in lower camelCase, always used with a suffix (`customerRepository`), so never a keyword */
    one: type.charAt(0).toLowerCase() + type.slice(1),
    plural: swPascal(plural),
  }
}

/** The Swift property of a field: its JSON name in camelCase. */
export function property(field: SpecField): string {
  return swName(field.wire)
}

/** The column of a field: its JSON name in snake_case. */
export function column(field: SpecField): string {
  return toSnakeCase(field.wire) || 'value'
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((item) => item.name === resource.key.field)!
}

/** The Swift type of the key: whole numbers are always `Int64`. */
export function keyType(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return 'Int64'
  if (resource.key.type.scalar === 'uuid') return 'UUID'
  return 'String'
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
