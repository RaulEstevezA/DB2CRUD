/**
 * What Rust generators need: identifiers, literals, the Rust type of each API type and the `use` declarations of
 * a source file. Axum uses it; another Rust framework would too.
 */
import type { SpecType } from '../../../api/spec.ts'
import { toPascalCase, toSnakeCase } from '../../../model/naming.ts'

/** Keywords of Rust: a name can only be one of them as a raw identifier (`r#type`). */
const KEYWORDS = new Set(
  (
    'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut ' +
    'pub ref return self static struct super trait true type unsafe use where while abstract become box do final macro ' +
    'override priv typeof unsized virtual yield try gen'
  ).split(' '),
)

/** Names a raw identifier cannot take either. */
const NOT_RAW = new Set(['crate', 'self', 'super', 'Self'])

/**
 * Type names a generated type cannot take: the prelude of Rust, the types the files of an Axum project import,
 * and the types the project writes itself. A model with one of these names gets `Item` after it.
 */
const TAKEN_TYPES = new Set(
  (
    'Option Result String Vec Box Some None Ok Err Self Json Path Query State Router Response StatusCode Value Map ' +
    'Bytes Uuid Decimal NaiveDate NaiveDateTime DateTime Utc Model Entity Column ActiveModel Relation Settings AppState ' +
    'ApiError ErrorDetail Checks Body ListQuery ListResult PageResponse Clock Authenticated Claims Ordering'
  ).split(' '),
)

/** A PascalCase name for a type or an enum variant. */
export function rsPascal(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** A type name that does not clash with the types every file of the project sees. */
export function rsType(name: string): string {
  const pascal = rsPascal(name)
  return TAKEN_TYPES.has(pascal) ? `${pascal}Item` : pascal
}

/** A snake_case name for fields, variables and functions; a keyword becomes a raw identifier. */
export function rsName(name: string): string {
  const snake = toSnakeCase(name) || 'value'
  const safe = /^[0-9]/.test(snake) ? `_${snake}` : snake
  if (NOT_RAW.has(safe)) return `${safe}_`
  return KEYWORDS.has(safe) ? `r#${safe}` : safe
}

/** A snake_case name for a module or a file, never a keyword. */
export function rsModule(name: string): string {
  const snake = toSnakeCase(name) || 'item'
  const safe = /^[0-9]/.test(snake) ? `_${snake}` : snake
  return KEYWORDS.has(safe) || NOT_RAW.has(safe) ? `${safe}_` : safe
}

/** A Rust string literal. */
export function rsString(value: string): string {
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '\\') text += '\\\\'
    else if (char === '"') text += '\\"'
    else if (char === '\n') text += '\\n'
    else if (char === '\r') text += '\\r'
    else if (char === '\t') text += '\\t'
    else if (code < 0x20) text += `\\u{${code.toString(16)}}`
    else text += char
  }
  return `"${text}"`
}

/** A documentation comment, indented: `/// text`. */
export function rsDoc(text: string, indent = ''): string {
  return text
    .split('\n')
    .map((line) => `${indent}/// ${line}`.trimEnd())
    .join('\n')
}

/** The `use` declarations of a file: std first, then other crates, then this crate; each group sorted. */
export class RsUses {
  private readonly items = new Set<string>()

  add(...paths: string[]): this {
    for (const path of paths) this.items.add(path)
    return this
  }

  render(): string {
    const all = [...this.items].sort()
    const group = (path: string) => (path.startsWith('std::') ? 0 : path.startsWith('crate::') ? 2 : 1)
    return [0, 1, 2]
      .map((index) => all.filter((path) => group(path) === index).map((path) => `use ${path};`))
      .filter((items) => items.length > 0)
      .map((items) => items.join('\n'))
      .join('\n\n')
  }
}

/** The opening of a Rust module: its documentation and its `use` declarations. */
export function rsHeader(doc: string, uses: RsUses): string[] {
  const rendered = uses.render()
  return [...doc.split('\n').map((line) => `//! ${line}`.trimEnd()), '', ...(rendered ? [rendered, ''] : [])]
}

/** Where the types generated for embedded objects and enums live. */
export interface RsTypeNames {
  /** The `use` path of the type of an embedded object or an enum */
  shared(name: string): string
}

/**
 * The Rust type of an API type, without the `Option` of the outermost type.
 *
 * @param type The type.
 * @param uses Collects the `use` declarations the type needs.
 * @param names Where embedded objects and enums live.
 */
export function rsTypeOf(type: SpecType, uses: RsUses, names: RsTypeNames): string {
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
        case 'time':
        case 'duration':
        case 'binary':
          return 'String'
        case 'integer':
          return type.bits === 64 ? 'i64' : 'i32'
        case 'float':
          return 'f64'
        case 'decimal':
          uses.add('rust_decimal::Decimal')
          return 'Decimal'
        case 'boolean':
          return 'bool'
        case 'date':
          uses.add('chrono::NaiveDate')
          return 'NaiveDate'
        case 'datetime':
          uses.add('chrono::DateTime', 'chrono::Utc')
          return 'DateTime<Utc>'
        case 'uuid':
          uses.add('uuid::Uuid')
          return 'Uuid'
        case 'any':
          uses.add('serde_json::Value')
          return 'Value'
      }
      return 'String'
    case 'array':
      return `Vec<${rsTypeOf(type.items, uses, names)}>`
    case 'map':
      uses.add('std::collections::BTreeMap')
      return `BTreeMap<String, ${rsTypeOf(type.value, uses, names)}>`
    case 'object':
    case 'enum': {
      const path = names.shared(type.name)
      uses.add(path)
      return path.slice(path.lastIndexOf('::') + 2)
    }
  }
}
