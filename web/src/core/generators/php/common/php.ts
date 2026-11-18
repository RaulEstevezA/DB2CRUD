/**
 * What the PHP generators need: identifiers (PascalCase classes, camelCase members and variables), PHP literals,
 * reaching a property whatever its name, and the `use` statements of a file, sorted, without the ones of its own
 * namespace.
 */
import { toCamelCase, toPascalCase } from '../../../model/naming.ts'

/** Names a class cannot have (they are keywords or types of PHP). */
const RESERVED_CLASSES = new Set(
  (
    'abstract and array as bool break callable case catch class clone const continue declare default do echo else ' +
    'elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends false final finally float fn for ' +
    'foreach function global goto if implements include instanceof insteadof int interface isset iterable list match mixed ' +
    'namespace never new null object or parent print private protected public readonly require return self static string ' +
    'switch throw trait true try unset use var void while xor yield'
  ).split(' '),
)

/** `order line` → `OrderLine`; a name PHP keeps for itself gets `Entity` after it. */
export const pascalName = (name: string) => {
  const base = toPascalCase(name) || 'Item'
  const safe = /^[0-9]/.test(base) ? `_${base}` : base
  return RESERVED_CLASSES.has(safe.toLowerCase()) ? `${safe}Entity` : safe
}

/** A name for a variable, a parameter or a field: `order_id` → `orderId` (`$this` is taken). */
export const fieldName = (name: string) => {
  const base = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(base) ? `_${base}` : base
  return safe === 'this' ? 'this_' : safe
}

/** A PHP single-quoted string. */
export function phpString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** A PHP literal for a number, a string, a boolean or null. */
export function phpLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  return phpString(value)
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `$entity->email`, or `$entity->{'odd name'}` for a name that is not an identifier. */
export const access = (target: string, property: string) =>
  IDENTIFIER.test(property) ? `${target}->${property}` : `${target}->{${phpString(property)}}`

/** A type that can hold null: `?int`; `mixed` already can. */
export const nullable = (type: string) => (type === 'mixed' ? 'mixed' : `?${type}`)

/** The `use` statements of one file, sorted, without the classes of its own namespace. */
export class PhpUses {
  private readonly names = new Set<string>()
  private readonly ns: string

  constructor(ns: string) {
    this.ns = ns
  }

  /** Classes by their full name: `App\Errors\NotFoundException`. */
  add(...names: string[]): this {
    for (const name of names) this.names.add(name)
    return this
  }

  write(): string {
    const own = (name: string) => name.slice(0, name.lastIndexOf('\\')) === this.ns
    return [...this.names]
      .filter((name) => !own(name))
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
      .map((name) => `use ${name};`)
      .join('\n')
  }
}
