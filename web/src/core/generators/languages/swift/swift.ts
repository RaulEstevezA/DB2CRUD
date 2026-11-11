/**
 * What Swift generators need: identifiers, literals and the Swift type of each API type. Vapor uses it; another
 * Swift framework would too.
 */
import type { SpecType } from '../../../api/spec.ts'
import { toCamelCase, toPascalCase } from '../../../model/naming.ts'

/** Keywords of Swift: a name can only be one of them between backticks. */
const KEYWORDS = new Set(
  (
    'associatedtype class deinit enum extension fileprivate func import inout internal let open operator private ' +
    'precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default ' +
    'defer do else fallthrough for guard if in repeat return throw switch where while as await false is nil super ' +
    'throws true try any some'
  ).split(' '),
)

/** Names that even backticks do not free for a property: they take `_` after them. */
const NOT_ESCAPABLE = new Set(['self', 'Self', 'init', 'Type', 'Protocol'])

/**
 * Type names a generated type cannot take: the types of Swift, Foundation, Vapor and Fluent every file may see,
 * and the types the project writes itself. A model with one of these names gets `Item` after it.
 */
const TAKEN_TYPES = new Set(
  (
    'Any String Int Int32 Int64 Double Float Bool Array Dictionary Set Optional Result Error Never Void Character Range ' +
    'Date UUID Data Decimal URL Codable Encodable Decodable Sendable Task Actor Request Response Application Route ' +
    'Routes RoutesBuilder Abort HTTPStatus HTTPMethod HTTPHeaders Environment Model Fields Migration AsyncMigration ' +
    'Database Schema Field Content Validation Validator Middleware Logger Storage Page Sort Filter JSON JSONValue ' +
    'ApiError ErrorDetail Checks JsonKind Body ListQuery ListResult PageResponse Clock Settings Security Claims ' +
    'Authenticated Params TestResponse Api TestLock'
  ).split(' '),
)

/** A PascalCase name for a type or a case. */
export function swPascal(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** A type name that does not clash with the types every file of the project sees. */
export function swType(name: string): string {
  const pascal = swPascal(name)
  return TAKEN_TYPES.has(pascal) ? `${pascal}Item` : pascal
}

/** A camelCase name for properties, variables and functions; a keyword goes between backticks. */
export function swName(name: string): string {
  const camel = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel
  if (NOT_ESCAPABLE.has(safe)) return `${safe}_`
  return KEYWORDS.has(safe) ? `\`${safe}\`` : safe
}

/** A Swift string literal. */
export function swString(value: string): string {
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
export function swDoc(text: string, indent = ''): string {
  return text
    .split('\n')
    .map((line) => `${indent}/// ${line}`.trimEnd())
    .join('\n')
}

/** The opening of a Swift file: what it holds and its imports, sorted. */
export function swHeader(doc: string, imports: Iterable<string>): string[] {
  const sorted = [...new Set(imports)].sort()
  return [
    ...doc.split('\n').map((line) => `// ${line}`.trimEnd()),
    '',
    ...(sorted.length > 0 ? [...sorted.map((item) => `import ${item}`), ''] : []),
  ]
}

/** Where the types generated for embedded objects and enums are named. */
export interface SwTypeNames {
  shared(name: string): string
}

/**
 * The Swift type of an API type, without the `?` of the outermost type. Dates without time are ISO 8601 text;
 * decimals are `Decimal`.
 */
export function swTypeOf(type: SpecType, names: SwTypeNames): string {
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'integer':
          return type.bits === 64 ? 'Int64' : 'Int32'
        case 'float':
          return 'Double'
        case 'decimal':
          return 'Decimal'
        case 'boolean':
          return 'Bool'
        case 'datetime':
          return 'Date'
        case 'uuid':
          return 'UUID'
        case 'any':
          return 'JSONValue'
      }
      return 'String'
    case 'array':
      return `[${swTypeOf(type.items, names)}]`
    case 'map':
      return `[String: ${swTypeOf(type.value, names)}]`
    case 'object':
    case 'enum':
      return names.shared(type.name)
  }
}
