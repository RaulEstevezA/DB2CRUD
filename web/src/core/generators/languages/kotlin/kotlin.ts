/**
 * What Kotlin generators need: identifiers, literals, the Kotlin type of each API type and the imports of a
 * source file. Ktor uses it; another Kotlin framework would too.
 */
import type { SpecType } from '../../../api/spec.ts'
import { toCamelCase, toPascalCase, toScreamingSnakeCase } from '../../../model/naming.ts'

/** Hard keywords of Kotlin: a name can only be one of them between backticks. */
const KEYWORDS = new Set(
  (
    'as break class continue do else false for fun if in interface is null object package return super this throw ' +
    'true try typealias typeof val var when while'
  ).split(' '),
)

/**
 * Type names a generated class cannot take: the types of Kotlin, the JVM and Ktor every file may use, and the
 * classes the project writes itself. A model with one of these names gets `Item` after it (`Route` → `RouteItem`).
 */
const TAKEN_TYPES = new Set(
  (
    'Any Array Boolean Byte Char Double Enum Error Exception Float Int List Long Map Nothing Number Pair Regex Result ' +
    'Set Short String Unit Application Route Routing Database Table Column Query Instant LocalDate UUID BigDecimal Json ' +
    'JsonObject JsonElement Body Checks ApiException ErrorResponse ErrorBody ErrorDetail ListQuery ListResult ' +
    'PageResponse Clock Settings Tables'
  ).split(' '),
)

/** A PascalCase name for a class. */
export function ktPascal(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** A class name that does not clash with the types every file of the project sees. */
export function ktClass(name: string): string {
  const pascal = ktPascal(name)
  return TAKEN_TYPES.has(pascal) ? `${pascal}Item` : pascal
}

/** A camelCase name for properties, parameters and functions; a hard keyword goes between backticks. */
export function ktName(name: string): string {
  const camel = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel
  return KEYWORDS.has(safe) ? `\`${safe}\`` : safe
}

/** An enum entry: `in progress` → `IN_PROGRESS`. */
export function ktConstant(value: string | number): string {
  const name = toScreamingSnakeCase(String(value)) || 'VALUE'
  return /^[0-9]/.test(name) ? `VALUE_${name}` : name
}

/** A package: each segment that is a hard keyword between backticks. */
export function ktPackage(name: string): string {
  return name
    .split('.')
    .map((part) => (KEYWORDS.has(part) ? `\`${part}\`` : part))
    .join('.')
}

/** A Kotlin string literal: `$` is escaped too, as Kotlin reads it as a template. */
export function ktString(value: string): string {
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '\\') text += '\\\\'
    else if (char === '"') text += '\\"'
    else if (char === '$') text += '\\$'
    else if (char === '\n') text += '\\n'
    else if (char === '\r') text += '\\r'
    else if (char === '\t') text += '\\t'
    else if (code < 0x20) text += `\\u${code.toString(16).padStart(4, '0')}`
    else text += char
  }
  return `"${text}"`
}

/** A number as a Kotlin literal of a type: `5L`, `1.5`, `BigDecimal("2.25")`. */
export function ktNumber(value: number, type: 'Int' | 'Long' | 'Double'): string {
  if (type === 'Long') return `${value}L`
  if (type === 'Double') return Number.isInteger(value) ? `${value}.0` : String(value)
  return String(value)
}

/** A documentation comment, indented. */
export function ktDoc(text: string, indent = ''): string {
  const body = text.split('\n')
  if (body.length === 1) return `${indent}/** ${text} */`
  return [`${indent}/**`, ...body.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`].join('\n')
}

/** Imports of a Kotlin file, sorted as ktlint does: others first, then java, javax and kotlin. */
export class KtImports {
  private readonly items = new Set<string>()
  private readonly ownPackage: string

  /** @param ownPackage The package of the file: its classes need no import. */
  constructor(ownPackage: string) {
    this.ownPackage = ownPackage
  }

  add(...names: string[]): this {
    for (const name of names) if (name.slice(0, name.lastIndexOf('.')) !== this.ownPackage) this.items.add(name)
    return this
  }

  render(): string {
    const group = (name: string) => (name.startsWith('java.') ? 1 : name.startsWith('javax.') ? 2 : name.startsWith('kotlin.') ? 3 : 0)
    return [...this.items]
      .sort((a, b) => group(a) - group(b) || (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => `import ${ktPackage(name)}`)
      .join('\n')
  }
}

/** The opening of a Kotlin file: its package and imports. */
export function ktHeader(pkg: string, imports: KtImports): string[] {
  const rendered = imports.render()
  return [`package ${ktPackage(pkg)}`, '', ...(rendered ? [rendered, ''] : [])]
}

/** Where the classes generated for embedded objects and enums live, and the shared helpers. */
export interface KtTypeNames {
  /** Fully qualified name of the class of an embedded object or an enum */
  shared(name: string): string
  /** Fully qualified name of a helper type of the project (`JsonDecimal`…) */
  common(name: string): string
}

/**
 * The Kotlin type of an API type, without the nullability of the outermost type.
 *
 * Dates, times, decimals and UUIDs use the project's serializable aliases (`JsonDate`…), so the same class is
 * read from and written to JSON.
 */
export function ktType(type: SpecType, imports: KtImports, names: KtTypeNames): string {
  const helper = (name: string) => {
    imports.add(names.common(name))
    return name
  }
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
        case 'time':
        case 'duration':
        case 'binary':
          return 'String'
        case 'integer':
          return type.bits === 64 ? 'Long' : 'Int'
        case 'float':
          return 'Double'
        case 'decimal':
          return helper('JsonDecimal')
        case 'boolean':
          return 'Boolean'
        case 'date':
          return helper('JsonDate')
        case 'datetime':
          return helper('JsonDateTime')
        case 'uuid':
          return helper('JsonUuid')
        case 'any':
          imports.add('kotlinx.serialization.json.JsonElement')
          return 'JsonElement'
      }
      return 'String'
    case 'array':
      return `List<${ktType(type.items, imports, names)}>`
    case 'map':
      return `Map<String, ${ktType(type.value, imports, names)}>`
    case 'object':
    case 'enum': {
      const qualified = names.shared(type.name)
      imports.add(qualified)
      return qualified.slice(qualified.lastIndexOf('.') + 1)
    }
  }
}
