/**
 * What the C# generator needs: identifiers (PascalCase members and types, camelCase locals), C# literals, and the
 * usings of a file, sorted, without the ones of its own namespace.
 */
import { toCamelCase, toPascalCase } from '../../model/naming.ts'

const KEYWORDS = new Set(
  (
    'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double ' +
    'else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is ' +
    'lock long namespace new null object operator out override params private protected public readonly ref return sbyte ' +
    'sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ' +
    'ushort using virtual void volatile while value record'
  ).split(' '),
)

/** A name C# accepts as a local or parameter: keywords get a leading `@`. */
export const localName = (name: string) => {
  const base = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(base) ? `_${base}` : base
  return KEYWORDS.has(safe) ? `@${safe}` : safe
}

/** `order line` → `OrderLine`. */
export const pascalName = (name: string) => {
  const base = toPascalCase(name) || 'Item'
  return /^[0-9]/.test(base) ? `_${base}` : base
}

/** A C# string literal. */
export function csString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

/** The usings of one file, sorted, without its own namespace (and System first, as dotnet format leaves them). */
export class CsUsings {
  private readonly names = new Set<string>()
  private readonly ns: string

  constructor(ns: string) {
    this.ns = ns
  }

  add(...names: string[]): this {
    for (const name of names) this.names.add(name)
    return this
  }

  write(): string {
    const system = (name: string) => name === 'System' || name.startsWith('System.')
    return [...this.names]
      .filter((name) => name !== this.ns)
      .sort((a, b) => Number(!system(a)) - Number(!system(b)) || (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => `using ${name};`)
      .join('\n')
  }
}
