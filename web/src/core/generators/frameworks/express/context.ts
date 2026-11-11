/**
 * Shared context of the Express generator: where each module goes for the chosen architecture (Strategy
 * pattern: `layered` or `modular`), relative imports between them, and the names of each resource.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { tsFile, tsName, tsType } from '../../languages/typescript/typescript.ts'

export type ResourceModule = 'schemas' | 'repository' | 'service' | 'routes'

/** The architecture strategy: the file of each module, relative to the project. */
export interface Layout {
  resource(resource: SpecResource, kind: ResourceModule): string
  shared(): string
}

const LAYERED: Record<ResourceModule, string> = { schemas: 'schemas', repository: 'repositories', service: 'services', routes: 'routes' }

const layered: Layout = {
  resource: (resource, kind) => `src/${LAYERED[kind]}/${tsFile(resource.name)}.ts`,
  shared: () => 'src/schemas/shared.ts',
}

const modular: Layout = {
  resource: (resource, kind) => `src/${tsFile(resource.name)}/${tsFile(resource.name)}.${kind}.ts`,
  shared: () => 'src/shared/schemas.ts',
}

export interface ExpressContext {
  spec: ApiSpec
  settings: ProjectSettings
  layout: Layout
  pending: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): ExpressContext {
  return { spec, settings, layout: settings.architecture === 'modular' ? modular : layered, pending: settings.persistence === 'none' }
}

/** The import specifier of `target` from `from`, both project paths, with the `.js` extension NodeNext needs. */
export function importPath(from: string, target: string): string {
  const fromParts = from.split('/').slice(0, -1)
  const targetParts = target.split('/')
  let common = 0
  while (common < fromParts.length && fromParts[common] === targetParts[common]) common++
  const up = fromParts.length - common
  const rest = targetParts.slice(common).join('/').replace(/\.ts$/, '.js')
  return `${up === 0 ? './' : '../'.repeat(up)}${rest}`
}

/** Names of a resource in the code. */
export function names(resource: SpecResource) {
  const type = tsType(resource.name)
  return {
    type,
    create: `${type}Create`,
    update: `${type}Update`,
    record: `${type}Record`,
    repository: `${type}Repository`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    service: `${type}Service`,
    toResponse: `to${type}`,
    routes: `${tsName(resource.name)}Routes`,
    one: tsName(resource.name),
    many: tsName(resource.plural.replace(/ /g, '_')),
  }
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

/** The TypeScript type of a key. */
export function keyType(resource: SpecResource): string {
  return resource.key.type.scalar === 'integer' ? 'number' : 'string'
}
