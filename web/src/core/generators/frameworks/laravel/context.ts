/**
 * Shared context of the Laravel generator: the namespace of each class for the chosen architecture
 * (Strategy pattern: `layered` groups classes by kind, as Laravel does; `modular` keeps one folder per
 * resource), and the names of each resource's classes, table and columns.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { phpClass, phpSnake } from '../../languages/php/php.ts'
import { resourceNames, type PhpProject } from '../../languages/php/project.ts'

export type ClassKind = 'controller' | 'request' | 'resource' | 'service' | 'repository' | 'model'

export interface Layout {
  /** Namespace of a resource's class of this kind */
  resource(resource: SpecResource, kind: ClassKind): string
  /** Namespace of the enums */
  enums(): string
}

const LAYERED: Record<ClassKind, string> = {
  controller: 'App\\Http\\Controllers',
  request: 'App\\Http\\Requests',
  resource: 'App\\Http\\Resources',
  service: 'App\\Services',
  repository: 'App\\Repositories',
  model: 'App\\Models',
}

const layered: Layout = {
  resource: (_resource, kind) => LAYERED[kind],
  enums: () => 'App\\Enums',
}

const modular: Layout = {
  resource: (resource) => `App\\Modules\\${phpClass(resource.name)}`,
  enums: () => 'App\\Modules\\Shared',
}

export interface LaravelContext extends PhpProject {
  layout: Layout
  eloquent: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): LaravelContext {
  const layout = settings.architecture === 'modular' ? modular : layered
  return {
    spec,
    settings,
    layout,
    pending: settings.persistence === 'none',
    eloquent: settings.persistence === 'eloquent',
    exceptions: 'App\\Exceptions',
    support: 'App\\Support',
    namespace: (resource, kind) => layout.resource(resource, kind),
    classPath,
    // The timestamp the server writes: UTC, ISO 8601 with milliseconds, as JavaScript's toISOString
    now: "now()->utc()->format('Y-m-d\\TH:i:s.v\\Z')",
    uuid: { expression: '(string) Str::uuid()', imports: ['Illuminate\\Support\\Str'] },
    tests: {
      namespace: 'Tests\\Feature',
      folder: 'tests/Feature',
      base: 'Tests\\TestCase',
      data: 'Tests\\TestData',
      dataPath: 'tests/TestData.php',
    },
  }
}

/** Path of the file of a class, from its namespace (PSR-4: `App\` is `app/`). */
export function classPath(namespace: string, name: string): string {
  return `${namespace
    .replace(/^App(\\|$)/, 'app$1')
    .split('\\')
    .join('/')}/${name}.php`
}

/** Names of a resource's classes, table and variables. */
export function names(resource: SpecResource) {
  const shared = resourceNames(resource)
  const type = shared.type
  return {
    ...shared,
    controller: `${type}Controller`,
    store: `Store${type}Request`,
    update: `Update${type}Request`,
    resource: `${type}Resource`,
    eloquentRepository: `Eloquent${type}Repository`,
    model: type,
    table: phpSnake(resource.plural.replace(/ /g, '_')),
  }
}

/** The fully qualified name of a resource's class. */
export function qualified(context: LaravelContext, resource: SpecResource, kind: ClassKind, name: string): string {
  return `${context.layout.resource(resource, kind)}\\${name}`
}

/** The column of a field: its JSON name in snake_case (`customerId` → `customer_id`). */
export function column(field: SpecField): string {
  return phpSnake(field.wire)
}

export { article, capitalize, innerObject, keyField, keyType, referencedResources } from '../../languages/php/project.ts'
