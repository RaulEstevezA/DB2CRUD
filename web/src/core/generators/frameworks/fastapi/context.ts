/**
 * Shared context of the FastAPI generator: where each module goes for the chosen architecture (Strategy
 * pattern: `layered` or `modular`), and the Python names of resources and fields. Every other module of the
 * generator asks the context instead of building paths or names on its own.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import { pyClass, pyModule, pyName } from '../../languages/python/python.ts'

/** The kinds of module a resource has. */
export type ResourceModule = 'schemas' | 'models' | 'repository' | 'service' | 'router'

/** Where a module lives: its file and its import path. */
export interface ModuleLocation {
  file: string
  module: string
}

/** The architecture strategy: the location of each module. */
export interface Layout {
  resource(resource: SpecResource, kind: ResourceModule): ModuleLocation
  /** Enums and embedded objects shared by every resource */
  shared(): ModuleLocation
}

const LAYERED_FOLDERS: Record<ResourceModule, string> = {
  schemas: 'schemas',
  models: 'models',
  repository: 'repositories',
  service: 'services',
  router: 'routers',
}

/** One folder per layer: `app/routers/customer.py`, `app/services/customer.py`… */
const layered: Layout = {
  resource: (resource, kind) => {
    const name = pyModule(resource.name)
    return { file: `app/${LAYERED_FOLDERS[kind]}/${name}.py`, module: `app.${LAYERED_FOLDERS[kind]}.${name}` }
  },
  shared: () => ({ file: 'app/schemas/common.py', module: 'app.schemas.common' }),
}

/** One folder per resource: `app/customer/router.py`, `app/customer/service.py`… */
const modular: Layout = {
  resource: (resource, kind) => {
    const name = pyModule(resource.name)
    return { file: `app/${name}/${kind}.py`, module: `app.${name}.${kind}` }
  },
  shared: () => ({ file: 'app/shared/schemas.py', module: 'app.shared.schemas' }),
}

export interface FastApiContext {
  spec: ApiSpec
  settings: ProjectSettings
  layout: Layout
  sql: boolean
  /** Repositories that raise "not implemented" in every method */
  pending: boolean
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): FastApiContext {
  return {
    spec,
    settings,
    layout: settings.architecture === 'modular' ? modular : layered,
    sql: settings.persistence === 'sqlalchemy',
    pending: settings.persistence === 'none',
  }
}

/** Python attribute of a field: the reference's wire name for references (`customer_id`), its own name otherwise. */
export function attr(field: SpecField): string {
  return pyName(field.reference ? field.wire : field.name)
}

/** Class names of a resource. */
export function classes(resource: SpecResource) {
  const base = pyClass(resource.name)
  return {
    read: base,
    create: `${base}Create`,
    update: `${base}Update`,
    model: `${base}Model`,
    repository: `${base}Repository`,
    memory: `InMemory${base}Repository`,
    sqlRepository: `Sql${base}Repository`,
    pendingRepository: `Pending${base}Repository`,
    service: `${base}Service`,
  }
}

/** Python names of the resource for variables and functions: `order_line`, `order_lines`. */
export function names(resource: SpecResource) {
  return { one: pyName(resource.name), many: pyName(resource.plural.replace(/ /g, '_')) }
}

/** Table of a resource: `order_lines`. */
export function tableName(resource: SpecResource): string {
  return pyModule(resource.plural.replace(/ /g, '_'))
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}
