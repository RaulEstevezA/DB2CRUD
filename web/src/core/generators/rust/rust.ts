/**
 * What the Rust generator needs: identifiers (snake_case members and modules, PascalCase types), Rust literals, and
 * the `use` lines of a file, sorted. Rust refuses an unused import, so a file adds only what its code names.
 */
import { toPascalCase, toSnakeCase } from '../../model/naming.ts'

/** Keywords of Rust (2024 edition): a name that is one of them is written as a raw identifier. */
const KEYWORDS = new Set(
  'as async await break const continue dyn else enum extern false fn for gen if impl in let loop match mod move mut pub ref return static struct trait true try type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield'.split(
    ' ',
  ),
)

/** Keywords that cannot be raw identifiers: they get a `_` after them. */
const NOT_RAW = new Set(['crate', 'self', 'super', 'Self'])

function safe(name: string): string {
  const base = /^[0-9]/.test(name) ? `_${name}` : name
  if (NOT_RAW.has(base)) return `${base}_`
  return KEYWORDS.has(base) ? `r#${base}` : base
}

/** A field, variable, function or module name: `OrderID` → `order_id`; a keyword becomes `r#type`. */
export const snakeName = (name: string) => safe(toSnakeCase(name) || 'value')

/** `order line` → `OrderLine`. */
export const typeName = (name: string) => {
  const base = toPascalCase(name) || 'Item'
  return /^[0-9]/.test(base) ? `_${base}` : base
}

/** The variant of SeaORM's `Column` enum for a field: its name in UpperCamelCase, as the derive macro writes it. */
export function columnVariant(field: string): string {
  return field
    .replace(/^r#/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** A Rust string literal. */
export function rsString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

/** An owned String from a literal. */
export const owned = (text: string) => `${rsString(text)}.to_string()`

/** The `use` lines of one file, sorted. */
export class RsUses {
  private readonly names = new Set<string>()

  add(...names: string[]): this {
    for (const name of names) this.names.add(name)
    return this
  }

  write(): string {
    // Items of one path go together: `use sea_orm::{EntityTrait, QueryFilter};`
    const groups = new Map<string, string[]>()
    for (const name of this.names) {
      const split = name.lastIndexOf('::')
      const path = name.slice(0, split)
      groups.set(path, [...(groups.get(path) ?? []), name.slice(split + 2)])
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, items]) => {
        const sorted = [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        return sorted.length === 1 ? `use ${path}::${sorted[0]};` : `use ${path}::{${sorted.join(', ')}};`
      })
      .join('\n')
  }
}
