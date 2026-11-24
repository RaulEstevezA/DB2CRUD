/**
 * What every Python generator needs: identifiers that follow PEP 8, Python literals and the imports of a
 * module, written in the order Ruff's isort sorts them (standard library, third party, the project).
 */
import type { Literal } from '../../model/schema.ts'
import { splitWords, toPascalCase, toSnakeCase } from '../../model/naming.ts'

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
])

/** A name Python accepts: keywords and names that start with a digit get a trailing or leading `_`. */
function safe(name: string): string {
  const base = /^[0-9]/.test(name) ? `_${name}` : name
  return KEYWORDS.has(base) ? `${base}_` : base
}

/** `placedAt`, `placed_at` → `placed_at`. */
export function snakeName(name: string): string {
  return safe(toSnakeCase(name) || 'value')
}

/** `order line` → `OrderLine`. */
export function className(name: string): string {
  return safe(toPascalCase(name) || 'Item')
}

/** A camelCase neutral name (`listByCustomerId`) in Python: `list_by_customer_id`. */
export function methodName(neutral: string): string {
  return safe(splitWords(neutral).join('_').toLowerCase())
}

/** A Python literal. */
export function pyLiteral(value: Literal): string {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

const BUILTINS = new Set(['bool', 'bytes', 'float', 'int', 'list', 'str'])

const STANDARD = new Set([
  'builtins',
  'collections',
  'collections.abc',
  'contextlib',
  'dataclasses',
  'datetime',
  'decimal',
  'enum',
  'os',
  'typing',
  'urllib.parse',
  'uuid',
  'weakref',
])

/** The imports of one module, deduplicated and sorted into the three groups of isort. */
export class Imports {
  private readonly names = new Map<string, Set<string>>()
  private readonly modules = new Set<string>()
  private postponed = false
  private hidden = new Set<string>()

  /** `from __future__ import annotations`: annotations are not evaluated, so a method named `list` cannot
   * hide the built-in in the annotations after it. */
  annotations(): this {
    this.postponed = true
    return this
  }

  /** The names the attributes of a class hide from the annotations after them (a column named `date` hides the
   * type): they are imported under another name, which `local` gives. */
  hide(names: string[]): this {
    this.hidden = new Set(names)
    return this
  }

  /** How the module writes an imported or built-in name: `date_` or `builtins.str` when the class hides it. */
  local(name: string): string {
    if (!this.hidden.has(name)) return name
    if (!BUILTINS.has(name)) return `${name}_`
    this.module('builtins')
    return `builtins.${name}`
  }

  /** `from module import name` */
  from(module: string, ...names: string[]): this {
    const set = this.names.get(module) ?? new Set<string>()
    for (const name of names) set.add(name)
    this.names.set(module, set)
    return this
  }

  /** `import module` */
  module(module: string): this {
    this.modules.add(module)
    return this
  }

  /** The import lines, groups separated by a blank line. */
  write(local: string): string {
    const group = (module: string) => (STANDARD.has(module) ? 0 : module === local || module.startsWith(`${local}.`) ? 2 : 1)
    const groups: string[][] = [[], [], []]
    const all = new Set([...this.modules, ...this.names.keys()])
    for (const module of [...all].sort()) {
      const target = groups[group(module)]
      if (this.modules.has(module)) target.push(`import ${module}`)
      const names = this.names.get(module)
      if (names && names.size > 0) {
        // isort orders names case-sensitively with constants and classes first
        const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        target.push(`from ${module} import ${sorted.map((name) => (this.hidden.has(name) ? `${name} as ${name}_` : name)).join(', ')}`)
      }
    }
    if (this.postponed) groups.unshift(['from __future__ import annotations'])
    return groups
      .filter((items) => items.length > 0)
      .map((items) => items.join('\n'))
      .join('\n\n')
  }
}
