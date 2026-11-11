/**
 * A small YAML writer for JSON-like data (objects, arrays, strings, numbers, booleans and null), used for
 * the OpenAPI contract. It writes what the `yaml` library writes with `lineWidth: 0` for the same data,
 * but its rules are few and explicit, so the desktop version (Python) writes the same text byte for byte.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

// Values YAML 1.2 (core schema) would read as something other than text: they are quoted
const NOT_TEXT = [
  /^(?:~|[Nn]ull|NULL)?$/,
  /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  /^0o[0-7]+$/,
  /^[-+]?[0-9]+$/,
  /^0x[0-9a-fA-F]+$/,
  /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
]

// Text that cannot be written plain: a leading indicator, "- " or "? ", ": " or " #" inside, or a trailing
// space or colon
const NOT_PLAIN = /^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/
const DOCUMENT_MARKER = /^(%|---|\.\.\.)/m
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** Text in quotes: single quotes when it holds double ones and no single ones, as JSON otherwise. */
function quoted(text: string): string {
  if (text.includes('"') && !text.includes("'")) return `'${text}'`
  return JSON.stringify(text)
}

/** A literal block (`|`), for multi-line text that is not a key. */
function block(text: string, indent: string): string {
  const chomp = !text.endsWith('\n') ? '-' : /\n\n$/.test(text) ? '+' : ''
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  // When the first line with text starts with a space, the indentation has to be stated
  const header = `|${/^\n*[ \t]/.test(text) ? '2' : ''}${chomp}`
  return `${header}\n${body
    .split('\n')
    .map((line) => (line === '' ? '' : indent + line))
    .join('\n')}`
}

/**
 * A text scalar.
 *
 * @param value The text.
 * @param indent Indentation of a literal block's lines.
 * @param key Whether the text is a key, which cannot be a block.
 */
function text(value: string, indent: string, key: boolean): string {
  // A block cannot be a key, and a block of blank lines would read back as empty text
  if (CONTROL.test(value) || (value.includes('\n') && (key || value.trim() === ''))) return JSON.stringify(value)
  if (value.includes('\n')) return block(value, indent)
  if (NOT_PLAIN.test(value) || DOCUMENT_MARKER.test(value) || NOT_TEXT.some((pattern) => pattern.test(value))) return quoted(value)
  return value
}

function scalar(value: Exclude<YamlValue, YamlValue[] | { [key: string]: YamlValue }>, indent: string): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return text(value, indent, false)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('YAML cannot hold a number that is not finite')
    return Object.is(value, -0) ? '-0' : JSON.stringify(value)
  }
  return String(value)
}

const isCollection = (value: YamlValue): value is YamlValue[] | { [key: string]: YamlValue } => value !== null && typeof value === 'object'

const isEmpty = (value: YamlValue[] | { [key: string]: YamlValue }) =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0

/** The lines of a non-empty collection, each starting at `indent`. */
function collection(value: YamlValue[] | { [key: string]: YamlValue }, indent: string): string[] {
  const inner = `${indent}  `
  if (Array.isArray(value))
    return value.flatMap((item) => {
      if (!isCollection(item) || isEmpty(item))
        return [`${indent}- ${isCollection(item) ? (Array.isArray(item) ? '[]' : '{}') : scalar(item, inner)}`]
      // The first line of the item follows the dash; the rest keep the item's indentation
      const lines = collection(item, inner)
      return [`${indent}- ${lines[0].slice(inner.length)}`, ...lines.slice(1)]
    })
  return Object.entries(value).flatMap(([key, item]) => {
    const name = text(key, inner, true)
    if (!isCollection(item)) return [`${indent}${name}: ${scalar(item, inner)}`]
    if (isEmpty(item)) return [`${indent}${name}: ${Array.isArray(item) ? '[]' : '{}'}`]
    return [`${indent}${name}:`, ...collection(item, inner)]
  })
}

/**
 * Writes a value as a YAML document.
 *
 * @param value JSON-like data; an object is the usual document.
 * @returns The document, ending with a line break.
 */
export function toYaml(value: YamlValue): string {
  if (!isCollection(value)) return `${scalar(value, '')}\n`
  if (isEmpty(value)) return `${Array.isArray(value) ? '[]' : '{}'}\n`
  return `${collection(value, '').join('\n')}\n`
}
