/**
 * What the TypeScript generators share (Express and NestJS): identifiers, string and value literals,
 * property names that need quotes, and the imports of a module.
 */
import { toCamelCase, toPascalCase } from '../../../model/naming.ts'
import type { JsonValue } from '../../common/samples.ts'
import { compareText } from '../../common/text.ts'

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
  'any',
  'boolean',
  'number',
  'string',
  'symbol',
  'type',
  'object',
])

/** A camelCase identifier; a reserved word gets a trailing underscore. */
export function tsName(name: string): string {
  const camel = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel
  return RESERVED.has(safe) ? `${safe}_` : safe
}

/** A PascalCase type or class name. */
export function tsType(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** A file name in kebab case: `OrderLine` → `order-line`. */
export function tsFile(name: string): string {
  return tsName(name)
    .replace(/_$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

/** A string literal with single quotes. */
export function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/** A property name, quoted when it is not a plain identifier: `name`, `'postal-code'`. */
export function tsProperty(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : tsString(name)
}

/** A property access: `body.name`, `body['postal-code']`. */
export function tsAccess(target: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${target}.${name}` : `${target}[${tsString(name)}]`
}

/** A JSON value as a TypeScript literal. */
export function tsLiteral(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return tsString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tsLiteral).join(', ')}]`
  const entries = Object.entries(value).map(([key, item]) => `${tsProperty(key)}: ${tsLiteral(item)}`)
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
}

/** Imports a module needs, collected while writing it: packages first, then the project's own modules. */
export class TsImports {
  private readonly values = new Map<string, Set<string>>()
  private readonly types = new Map<string, Set<string>>()

  add(module: string, ...names: string[]): this {
    const set = this.values.get(module) ?? new Set<string>()
    for (const name of names) set.add(name)
    this.values.set(module, set)
    return this
  }

  /** `import type { … }`: names used only as types. */
  addType(module: string, ...names: string[]): this {
    const set = this.types.get(module) ?? new Set<string>()
    for (const name of names) set.add(name)
    this.types.set(module, set)
    return this
  }

  render(): string {
    const modules = [...new Set([...this.values.keys(), ...this.types.keys()])]
    const relative = (module: string) => module.startsWith('.')
    const order = (a: string, b: string) => Number(relative(a)) - Number(relative(b)) || compareText(a, b)
    return modules
      .sort(order)
      .map((module) => {
        const values = [...(this.values.get(module) ?? [])].filter((name) => !name.startsWith('* as ') && !name.startsWith('default '))
        const special = [...(this.values.get(module) ?? [])].filter((name) => name.startsWith('* as ') || name.startsWith('default '))
        const types = [...(this.types.get(module) ?? [])].filter((name) => !values.includes(name))
        const lines: string[] = []
        for (const name of special)
          lines.push(name.startsWith('default ') ? `import ${name.slice(8)} from '${module}'` : `import ${name} from '${module}'`)
        const named = [...values.sort(), ...types.sort().map((name) => `type ${name}`)]
        if (named.length > 0) lines.push(`import { ${named.join(', ')} } from '${module}'`)
        if (lines.length === 0) lines.push(`import '${module}'`)
        return lines.join('\n')
      })
      .join('\n')
  }
}

/** A documentation comment: the first lines of a module. */
export function tsDoc(text: string): string {
  const body = text.split('\n').map((line) => ` * ${line}`.trimEnd())
  return ['/**', ...body, ' */'].join('\n')
}
