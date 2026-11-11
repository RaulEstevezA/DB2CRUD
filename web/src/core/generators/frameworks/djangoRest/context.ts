/**
 * Shared context of the Django REST Framework generator: the Django app and module of each piece for the
 * chosen architecture (Strategy pattern: `layered` puts every resource in one `api` app, `modular` gives
 * each resource an app of its own), and a collector that writes each Python module once with its imports.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../../api/spec.ts'
import type { ProjectSettings } from '../../../compatibility/stack.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PyImports, pyClass, pyDocstring, pyModule, pyName } from '../../languages/python/python.ts'

export type ModuleKind = 'models' | 'serializers' | 'services' | 'views' | 'urls'

export interface Layout {
  /** The Django app of a resource */
  app(resource: SpecResource): string
  /** Apps to install, in order */
  apps(): string[]
  /** Module of the enums and of the serializers of embedded objects */
  sharedEnums(): string
  sharedSerializers(): string
}

export interface DjangoContext {
  spec: ApiSpec
  settings: ProjectSettings
  layout: Layout
}

export function createContext(spec: ApiSpec, settings: ProjectSettings): DjangoContext {
  const layered: Layout = {
    app: () => 'api',
    apps: () => ['api'],
    sharedEnums: () => 'api.models',
    sharedSerializers: () => 'api.serializers',
  }
  const modular: Layout = {
    app: (resource) => pyModule(resource.name),
    apps: () => ['common', ...spec.resources.map((resource) => pyModule(resource.name))],
    sharedEnums: () => 'common.enums',
    sharedSerializers: () => 'common.serializers',
  }
  return { spec, settings, layout: settings.architecture === 'modular' ? modular : layered }
}

/** The module of a resource's piece: `api.models`, `customer.views`. */
export function moduleOf(context: DjangoContext, resource: SpecResource, kind: ModuleKind): string {
  return `${context.layout.app(resource)}.${kind}`
}

/** Collects the blocks of each module and writes them with their docstring and imports. */
export class Modules {
  private readonly modules = new Map<string, { doc: string; imports: PyImports; blocks: string[] }>()

  /** The imports and blocks of a module, created with its docstring the first time. */
  get(module: string, doc: string): { imports: PyImports; blocks: string[] } {
    if (!this.modules.has(module)) this.modules.set(module, { doc, imports: new PyImports(), blocks: [] })
    return this.modules.get(module)!
  }

  files(): GeneratedFile[] {
    return [...this.modules.entries()].map(([module, { doc, imports, blocks }]) => {
      const rendered = imports.render()
      const content = lines(pyDocstring(doc), '', rendered, rendered && '', rendered && '', blocks.join('\n\n\n'))
      return { path: `${module.replace(/\./g, '/')}.py`, content: fileText(content) }
    })
  }
}

/** Names of a resource. */
export function names(resource: SpecResource) {
  const type = pyClass(resource.name)
  return {
    model: type,
    serializer: `${type}Serializer`,
    service: `${type}Service`,
    one: pyName(resource.name),
    many: pyName(resource.plural.replace(/ /g, '_')),
  }
}

/** The Python attribute of a field on its model: references use the field's name (`customer`), the rest too. */
export function attr(field: SpecField): string {
  return pyName(field.name)
}

export function keyField(resource: SpecResource): SpecField {
  return resource.fields.find((field) => field.name === resource.key.field)!
}

/** Whether a field is a reference to one item, stored as a foreign key. */
export function isForeignKey(field: SpecField): boolean {
  return field.reference !== undefined && field.type.kind === 'scalar'
}
