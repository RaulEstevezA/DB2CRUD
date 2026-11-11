/**
 * Shared context of the Symfony generator: the namespace of each class for the chosen architecture (Strategy
 * pattern: `layered` groups classes by kind, as Symfony does; `modular` keeps one folder per resource), the
 * names of each resource's classes and table, and the profile the shared PHP writers follow.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { phpClass, phpName, phpSnake } from '../../languages/php/php.ts'
import { resourceNames, type PhpProject } from '../../languages/php/project.ts'

export type ClassKind = 'controller' | 'input' | 'presenter' | 'service' | 'repository' | 'entity'

export interface Layout {
  /** Namespace of a resource's class of this kind */
  resource(resource: SpecResource, kind: ClassKind): string
  /** Namespace of the enums */
  enums(): string
}

const LAYERED: Record<ClassKind, string> = {
  controller: 'App\\Controller',
  input: 'App\\Input',
  presenter: 'App\\Presenter',
  service: 'App\\Service',
  repository: 'App\\Repository',
  entity: 'App\\Entity',
}

const layered: Layout = {
  resource: (_resource, kind) => LAYERED[kind],
  enums: () => 'App\\Enum',
}

const modular: Layout = {
  resource: (resource) => `App\\${phpClass(resource.name)}`,
  enums: () => 'App\\Shared',
}

export interface SymfonyContext extends PhpProject {
  layout: Layout
  doctrine: boolean
}

/** Path of the file of a class, from its namespace (PSR-4: `App\` is `src/`). */
export function classPath(namespace: string, name: string): string {
  return `${namespace
    .replace(/^App(\\|$)/, 'src$1')
    .split('\\')
    .join('/')}/${name}.php`
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): SymfonyContext {
  const layout = settings.architecture === 'modular' ? modular : layered
  return {
    spec,
    settings,
    layout,
    pending: settings.persistence === 'none',
    doctrine: settings.persistence === 'doctrine',
    exceptions: 'App\\Exception',
    support: 'App\\Support',
    namespace: (resource, kind) => layout.resource(resource, kind),
    classPath,
    // The timestamp the server writes: UTC, ISO 8601 with milliseconds, as JavaScript's toISOString
    now: "(new \\DateTimeImmutable('now', new \\DateTimeZone('UTC')))->format('Y-m-d\\TH:i:s.v\\Z')",
    uuid: { expression: 'Uuid::v4()->toRfc4122()', imports: ['Symfony\\Component\\Uid\\Uuid'] },
    tests: {
      namespace: 'App\\Tests\\Api',
      folder: 'tests/Api',
      base: 'App\\Tests\\ApiTestCase',
      data: 'App\\Tests\\TestData',
      dataPath: 'tests/TestData.php',
    },
  }
}

/** Names of a resource's classes and table. */
export function names(resource: SpecResource) {
  const shared = resourceNames(resource)
  const type = shared.type
  return {
    ...shared,
    controller: `${type}Controller`,
    input: `${type}Input`,
    presenter: `${type}Presenter`,
    doctrineRepository: `Doctrine${type}Repository`,
    entity: type,
    table: phpSnake(resource.plural.replace(/ /g, '_')),
  }
}

/** The fully qualified name of a resource's class. */
export function qualified(context: SymfonyContext, resource: SpecResource, kind: ClassKind, name: string): string {
  return `${context.layout.resource(resource, kind)}\\${name}`
}

/** The column of a field: its JSON name in snake_case (`customerId` → `customer_id`). */
export function column(field: SpecField): string {
  return phpSnake(field.wire)
}

/** The property of a field in an entity: its JSON name in camelCase. */
export function property(field: SpecField): string {
  return phpName(field.wire)
}
