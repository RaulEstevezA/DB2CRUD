/**
 * What the PHP generators share about a project (Laravel and Symfony): the profile each framework fills in
 * (where its classes go, how it writes a UUID, where its tests go) and helpers about resources, keys and
 * references that do not depend on the framework.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { phpClass, phpName } from './php.ts'

// Shared with every generator; kept importable from here for the PHP writers
export { innerObject, referencedResources } from '../../common/references.ts'

/** The framework-specific choices of a PHP project, which the shared writers follow. */
export interface PhpProject {
  spec: ApiSpec
  settings: ProjectSettings
  /** The storage is left to write: repositories answer 501 */
  pending: boolean
  /** Namespace of ApiException and NotImplementedException */
  exceptions: string
  /** Namespace of ListQuery, ListResult and Values */
  support: string
  /** Namespace of a resource's repository or service */
  namespace(resource: SpecResource, kind: 'repository' | 'service'): string
  /** Path of the file of a class (PSR-4) */
  classPath(namespace: string, name: string): string
  /** The expression of the current time the server writes: UTC, ISO 8601 with milliseconds */
  now: string
  /** How the in-memory storage writes a new UUID, and the classes it needs */
  uuid: { expression: string; imports: string[] }
  /** The tests: namespace and folder of the test classes, their base class and the trait with the test data */
  tests: { namespace: string; folder: string; base: string; data: string; dataPath: string }
}

/** Names of a resource's classes that every PHP framework shares. */
export function resourceNames(resource: SpecResource) {
  const type = phpClass(resource.name)
  return {
    type,
    service: `${type}Service`,
    repository: `${type}Repository`,
    memory: `InMemory${type}Repository`,
    pendingRepository: `Pending${type}Repository`,
    one: phpName(resource.name),
  }
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

/** The PHP type of the key: whole numbers are `int`, the rest text. */
export function keyType(resource: SpecResource): string {
  return resource.key.type.scalar === 'integer' ? 'int' : 'string'
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
