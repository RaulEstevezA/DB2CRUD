/**
 * What C# generators need: identifiers, literals, the C# type of each API type, the `using` directives of a
 * source file and documentation comments. ASP.NET Core uses it; another .NET framework would too.
 */
import type { SpecType } from '../../../api/spec.ts'
import { toCamelCase, toPascalCase } from '../../../model/naming.ts'

/** C# keywords, which a camelCase name cannot be without `@`. */
const KEYWORDS = new Set(
  (
    'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double ' +
    'else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal ' +
    'is lock long namespace new null object operator out override params private protected public readonly ref return ' +
    'sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked ' +
    'unsafe ushort using virtual void volatile while'
  ).split(' '),
)

/**
 * Type names a generated class cannot take: the types every file sees through the implicit `using` directives
 * of an ASP.NET Core project, its validation and JSON namespaces, and the classes the project writes itself.
 * A model with one of these names gets `Item` after it (`Task` → `TaskItem`).
 */
const TAKEN_TYPES = new Set(
  (
    'Action Activator Array Attribute Buffer Console Convert Delegate Directory Enum Environment Exception File Func ' +
    'Guid Index Lazy Math Monitor Nullable Object Path Program Random Range Stream String Task Thread Timeout Timer ' +
    'Tuple Type Uri Version Results Endpoint HttpContext Host Configuration Logger LogLevel ' +
    'Required Key Validator ValidationResult JsonElement JsonNode JsonObject JsonArray JsonSerializer ' +
    'ApiException ErrorResponse ListQuery ListResult PageResponse Payload Clock AppDbContext'
  ).split(' '),
)

/** A PascalCase name for a class, an enum member or a property. */
export function csPascal(name: string): string {
  const pascal = toPascalCase(name) || 'Value'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** A class name that does not clash with the types every file of the project sees. */
export function csClass(name: string): string {
  const pascal = csPascal(name)
  return TAKEN_TYPES.has(pascal) ? `${pascal}Item` : pascal
}

/** A camelCase name for parameters and variables; a keyword gets `@` before it. */
export function csName(name: string): string {
  const camel = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel
  return KEYWORDS.has(safe) ? `@${safe}` : safe
}

/** A property of a class: PascalCase, and never the name of the class itself (C# forbids it). */
export function csProperty(name: string, owner: string): string {
  const pascal = csPascal(name)
  return pascal === owner ? `${pascal}Value` : pascal
}

/** A regular C# string literal. */
export function csString(value: string): string {
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '\\') text += '\\\\'
    else if (char === '"') text += '\\"'
    else if (char === '\n') text += '\\n'
    else if (char === '\r') text += '\\r'
    else if (char === '\t') text += '\\t'
    else if (code < 0x20) text += `\\u${code.toString(16).padStart(4, '0')}`
    else text += char
  }
  return `"${text}"`
}

/** A number as a C# literal of a type: `5L`, `1.5`, `2.25m`. */
export function csNumber(value: number, type: 'int' | 'long' | 'double' | 'decimal'): string {
  if (type === 'long') return `${value}L`
  if (type === 'decimal') return `${value}m`
  if (type === 'double') return Number.isInteger(value) ? `${value}.0` : String(value)
  return String(value)
}

/** Text for an XML documentation comment, with &, < and > escaped. */
function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A documentation comment, indented: `/// <summary>…</summary>`. */
export function csDoc(text: string, indent = ''): string {
  const body = xmlText(text).split('\n')
  if (body.length === 1) return `${indent}/// <summary>${body[0]}</summary>`
  return [`${indent}/// <summary>`, ...body.map((line) => `${indent}/// ${line}`.trimEnd()), `${indent}/// </summary>`].join('\n')
}

/** The `using` directives of a file: System namespaces first, then the others, each group sorted. */
export class CsUsings {
  private readonly items = new Set<string>()
  private readonly ownNamespace: string

  /** @param ownNamespace The namespace of the file: its types need no directive. */
  constructor(ownNamespace: string) {
    this.ownNamespace = ownNamespace
  }

  add(...namespaces: string[]): this {
    for (const namespace of namespaces) if (namespace !== this.ownNamespace) this.items.add(namespace)
    return this
  }

  render(): string {
    const all = [...this.items].sort()
    const system = all.filter((item) => item === 'System' || item.startsWith('System.'))
    const others = all.filter((item) => item !== 'System' && !item.startsWith('System.'))
    return [...system, ...others].map((item) => `using ${item};`).join('\n')
  }
}

/** The opening of a C# file: its `using` directives and its file-scoped namespace. */
export function csHeader(namespace: string, usings: CsUsings): string[] {
  const rendered = usings.render()
  return [...(rendered ? [rendered, ''] : []), `namespace ${namespace};`, '']
}

/** Where the classes generated for embedded objects and enums live, and their names. */
export interface CsTypeNames {
  /** Namespace of the class of an embedded object or an enum */
  namespace(): string
}

/**
 * The C# type of an API type. Values can always be null (`?`), so a body can leave them out.
 *
 * @param type The type.
 * @param usings Collects the namespaces the type needs.
 * @param names Where embedded objects and enums live.
 * @param nullable Whether the outermost type is nullable.
 */
export function csType(type: SpecType, usings: CsUsings, names: CsTypeNames, nullable = true): string {
  const q = nullable ? '?' : ''
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
        case 'time':
        case 'duration':
          return `string${q}`
        case 'integer':
          return `${type.bits === 64 ? 'long' : 'int'}${q}`
        case 'float':
          return `double${q}`
        case 'decimal':
          return `decimal${q}`
        case 'boolean':
          return `bool${q}`
        case 'date':
          return `DateOnly${q}`
        case 'datetime':
          return `DateTimeOffset${q}`
        case 'uuid':
          return `Guid${q}`
        case 'binary':
          return `byte[]${q}`
        case 'any':
          usings.add('System.Text.Json')
          return `JsonElement${q}`
      }
      return `object${q}`
    case 'array':
      return `List<${csType(type.items, usings, names, false)}>${q}`
    case 'map':
      return `Dictionary<string, ${csType(type.value, usings, names, false)}>${q}`
    case 'object':
    case 'enum':
      usings.add(names.namespace())
      return `${csClass(type.name)}${q}`
  }
}
