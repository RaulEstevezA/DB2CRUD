/**
 * What every TypeScript generator needs: identifiers (camelCase members, PascalCase types, kebab-case files),
 * literals, and the imports of an ES module, with the `.js` extension NodeNext resolution asks for and paths
 * relative to the importing file.
 */
import type { Literal } from '../../model/schema.ts'
import { splitWords, toCamelCase, toPascalCase } from '../../model/naming.ts'

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
])

function safe(name: string): string {
  const base = /^[0-9]/.test(name) ? `_${name}` : name
  return RESERVED.has(base) ? `${base}_` : base
}

/** `created_at` → `createdAt`. */
export const memberName = (name: string) => safe(toCamelCase(name) || 'value')

/** `order line` → `OrderLine`. */
export const typeName = (name: string) => safe(toPascalCase(name) || 'Item')

/** `OrderLine` → `order-line`, for file names. */
export const fileName = (name: string) => splitWords(name).join('-').toLowerCase() || 'item'

/** A TypeScript literal. */
export function tsLiteral(value: Literal): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  return String(value)
}

/** A string in single quotes. */
export const quote = (text: string) => tsLiteral(text)

/** The path of `to` as an import from `from` (both module paths without extension, from the project root). */
export function relativeImport(from: string, to: string): string {
  if (!to.startsWith('src/') && !to.startsWith('test/')) return to
  const fromParts = from.split('/').slice(0, -1)
  const toParts = to.split('/')
  let common = 0
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++
  const up = fromParts.length - common
  const path = [...Array(up).fill('..'), ...toParts.slice(common)].join('/')
  return `${up === 0 ? './' : ''}${path}.js`
}

/** The imports of one module: packages first, then the project's own files, each sorted. */
export class TsImports {
  private readonly named = new Map<string, Set<string>>()
  private readonly types = new Map<string, Set<string>>()
  private readonly sideEffects = new Set<string>()

  private readonly self: string

  constructor(self: string) {
    this.self = self
  }

  /** `import { name } from 'module'`; `module` is a package or a project module path (`src/errors`). */
  from(module: string, ...names: string[]): this {
    const set = this.named.get(module) ?? new Set<string>()
    for (const name of names) set.add(name)
    this.named.set(module, set)
    return this
  }

  /** `import type { name } from 'module'` */
  type(module: string, ...names: string[]): this {
    const set = this.types.get(module) ?? new Set<string>()
    for (const name of names) set.add(name)
    this.types.set(module, set)
    return this
  }

  /** `import 'module'` */
  only(module: string): this {
    this.sideEffects.add(module)
    return this
  }

  write(): string {
    const modules = new Set([...this.named.keys(), ...this.types.keys()])
    const local = (module: string) => module.startsWith('src/') || module.startsWith('test/')
    const order = [...modules].sort((a, b) => Number(local(a)) - Number(local(b)) || (a < b ? -1 : a > b ? 1 : 0))
    const result: string[] = [...this.sideEffects].sort().map((module) => `import '${module}'`)
    for (const module of order) {
      if (module === this.self) continue
      const target = relativeImport(this.self, module)
      const values = [...(this.named.get(module) ?? [])].sort()
      const types = [...(this.types.get(module) ?? [])].filter((name) => !values.includes(name)).sort()
      if (values.length > 0) result.push(`import { ${[...values, ...types.map((name) => `type ${name}`)].join(', ')} } from '${target}'`)
      else if (types.length > 0) result.push(`import type { ${types.join(', ')} } from '${target}'`)
    }
    return result.join('\n')
  }
}
