/**
 * What the Python generators share (FastAPI and Django REST Framework): identifiers that follow PEP 8,
 * Python literals, and the Python type of each API type. Each framework adds its own syntax on top.
 */
import type { SpecType } from '../../../api/spec.ts'
import { toPascalCase, toSnakeCase } from '../../../model/naming.ts'
import type { JsonValue } from '../../common/samples.ts'
import { compareText } from '../../common/text.ts'

const KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
  'type',
  // Names the generated modules already use
  'id_',
  'self',
  'cls',
  'date',
  'datetime',
  'time',
  'decimal',
  'json',
  'uuid',
])

/** A snake_case identifier: `createdAt` → `created_at`; a keyword gets a trailing underscore. */
export function pyName(name: string): string {
  const snake = toSnakeCase(name) || 'value'
  const safe = /^[0-9]/.test(snake) ? `_${snake}` : snake
  return KEYWORDS.has(safe) ? `${safe}_` : safe
}

/** A PascalCase class name: `order_line` → `OrderLine`. */
export function pyClass(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** A Python module name: `OrderLine` → `order_line`. */
export function pyModule(name: string): string {
  return pyName(name).replace(/_$/, '')
}

/** A Python string literal with double quotes. */
export function pyString(value: string): string {
  return JSON.stringify(value)
}

/** A JSON value as a Python literal. */
export function pyLiteral(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return pyString(value)
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`
  return `{${Object.entries(value)
    .map(([key, item]) => `${pyString(key)}: ${pyLiteral(item)}`)
    .join(', ')}}`
}

/** Imports a module needs, collected while writing it and printed sorted at the top. */
export class PyImports {
  private readonly modules = new Map<string, Set<string>>()

  /** `from <module> import <name>` */
  add(module: string, ...names: string[]): this {
    const set = this.modules.get(module) ?? new Set<string>()
    for (const name of names) set.add(name)
    this.modules.set(module, set)
    return this
  }

  /** Import lines: standard library first, then third-party packages, then the project, as isort does. */
  render(): string {
    const groups: [string, string[]][] = [...this.modules.entries()].map(([module, names]) => [module, [...names].sort()])
    const isProject = (module: string) =>
      module === 'app' || module.startsWith('app.') || module.startsWith('.') || module === 'tests' || module.startsWith('tests.')
    const standard = new Set([
      '__future__',
      'collections.abc',
      'copy',
      'logging',
      'secrets',
      'dataclasses',
      'datetime',
      'decimal',
      'enum',
      'os',
      'typing',
      'uuid',
      'contextlib',
      'functools',
      'collections',
      'itertools',
    ])
    const line = ([module, names]: [string, string[]]) =>
      names.length === 0 ? `import ${module}` : `from ${module} import ${names.join(', ')}`
    const sorted = (items: [string, string[]][]) => items.sort((a, b) => compareText(a[0], b[0])).map(line)
    const blocks = [
      sorted(groups.filter(([module]) => standard.has(module))),
      sorted(groups.filter(([module]) => !standard.has(module) && !isProject(module))),
      sorted(groups.filter(([module]) => isProject(module))),
    ].filter((block) => block.length > 0)
    return blocks.map((block) => block.join('\n')).join('\n\n')
  }
}

/** Names of embedded objects and enums: their Python class, in the module that declares them. */
export interface PyTypeNames {
  object(name: string): string
  enum(name: string): string
}

/**
 * The Python annotation of an API type.
 *
 * @param type The type.
 * @param imports Collects the imports the annotation needs.
 * @param names Class names of the embedded objects and enums.
 */
export function pyType(type: SpecType, imports: PyImports, names: PyTypeNames): string {
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
          return 'str'
        case 'integer':
          return 'int'
        case 'float':
          return 'float'
        case 'decimal':
          imports.add('decimal', 'Decimal')
          return 'Decimal'
        case 'boolean':
          return 'bool'
        case 'date':
          imports.add('datetime', 'date')
          return 'date'
        case 'datetime':
          imports.add('datetime', 'datetime')
          return 'datetime'
        case 'time':
          imports.add('datetime', 'time')
          return 'time'
        case 'duration':
          imports.add('datetime', 'timedelta')
          return 'timedelta'
        case 'uuid':
          imports.add('uuid', 'UUID')
          return 'UUID'
        case 'binary':
          return 'bytes'
        case 'any':
          imports.add('typing', 'Any')
          return 'Any'
      }
      return 'Any'
    case 'array':
      return `list[${pyType(type.items, imports, names)}]`
    case 'map':
      return `dict[str, ${pyType(type.value, imports, names)}]`
    case 'object':
      return names.object(type.name)
    case 'enum':
      return names.enum(type.name)
  }
}

/** A module docstring: the first statement of a Python file. */
export function pyDocstring(text: string): string {
  return `"""${text}"""`
}
