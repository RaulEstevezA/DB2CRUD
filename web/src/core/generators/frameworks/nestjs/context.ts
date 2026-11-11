/**
 * Shared context of the NestJS generator: the files of each resource (one Nest module per resource, as
 * Nest organizes code), relative imports, and the names of each resource's classes.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { tsFile, tsName, tsType } from '../../languages/typescript/typescript.ts'

export type ResourceFile = 'module' | 'controller' | 'service' | 'repository' | 'dto' | 'entity'

export interface NestContext {
  spec: ApiSpec
  settings: ProjectSettings
  pending: boolean
  typeorm: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): NestContext {
  return { spec, settings, pending: settings.persistence === 'none', typeorm: settings.persistence === 'typeorm' }
}

/** `src/order-line/order-line.service.ts` */
export function resourcePath(resource: SpecResource, kind: ResourceFile): string {
  const file = tsFile(resource.name)
  return `src/${file}/${file}.${kind}.ts`
}

export const SHARED = 'src/shared/shared.dto.ts'

/** The import specifier of `target` from `from`, both project paths (CommonJS: no extension). */
export function importPath(from: string, target: string): string {
  const fromParts = from.split('/').slice(0, -1)
  const targetParts = target.split('/')
  let common = 0
  while (common < fromParts.length && fromParts[common] === targetParts[common]) common++
  const up = fromParts.length - common
  const rest = targetParts.slice(common).join('/').replace(/\.ts$/, '')
  return `${up === 0 ? './' : '../'.repeat(up)}${rest}`
}

export function names(resource: SpecResource) {
  const type = tsType(resource.name)
  return {
    type,
    create: `Create${type}Dto`,
    update: `Update${type}Dto`,
    query: `List${tsType(resource.plural.replace(/ /g, '_'))}Query`,
    record: `${type}Record`,
    entity: `${type}Entity`,
    repository: `${type}Repository`,
    token: `${tsName(resource.name).toUpperCase()}_REPOSITORY`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    typeormRepository: `TypeOrm${type}Repository`,
    service: `${type}Service`,
    controller: `${type}Controller`,
    module: `${type}Module`,
    toResponse: `to${type}`,
    one: tsName(resource.name),
    many: tsName(resource.plural.replace(/ /g, '_')),
  }
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

export function keyType(resource: SpecResource): string {
  return resource.key.type.scalar === 'integer' ? 'number' : 'string'
}
