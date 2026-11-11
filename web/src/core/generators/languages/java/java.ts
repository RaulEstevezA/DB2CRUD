/**
 * What Java generators need: identifiers, literals, the Java type of each API type, and the imports of a
 * source file. Spring Boot uses it; another JVM framework would too.
 */
import type { SpecType } from '../../../api/spec.ts'
import { toCamelCase, toPascalCase, toScreamingSnakeCase } from '../../../model/naming.ts'
import type { JsonValue } from '../../common/samples.ts'

const RESERVED = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'var',
  'record',
  'yield',
  'true',
  'false',
  'null',
])

/** A camelCase identifier; a reserved word gets a trailing underscore. */
export function javaName(name: string): string {
  const camel = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel
  return RESERVED.has(safe) ? `${safe}_` : safe
}

/** A PascalCase class name. */
export function javaClass(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
}

/** An enum constant: `in progress` → `IN_PROGRESS`. */
export function javaConstant(value: string | number): string {
  const name = toScreamingSnakeCase(String(value)) || 'VALUE'
  return /^[0-9]/.test(name) ? `VALUE_${name}` : name
}

/** A Java string literal. */
export function javaString(value: string): string {
  return JSON.stringify(value)
}

/** The getter of a property: `name` → `getName`, `active` → `getActive`. */
export function getter(property: string): string {
  return `get${property.charAt(0).toUpperCase()}${property.slice(1)}`
}

export function setter(property: string): string {
  return `set${property.charAt(0).toUpperCase()}${property.slice(1)}`
}

/** A JSON value as a Java text block for tests: the JSON exactly as written. */
export function javaJson(value: JsonValue): string {
  return javaString(JSON.stringify(value))
}

/** Imports of a Java source file, sorted, java.* first. */
export class JavaImports {
  private readonly items = new Set<string>()
  private readonly ownPackage: string

  /** @param ownPackage The package of the file: its classes need no import. */
  constructor(ownPackage: string) {
    this.ownPackage = ownPackage
  }

  add(...names: string[]): this {
    for (const name of names) {
      // Classes of the same package and of java.lang need no import
      const pkg = name.slice(0, name.lastIndexOf('.'))
      if (pkg !== this.ownPackage && pkg !== 'java.lang') this.items.add(name)
    }
    return this
  }

  render(): string {
    const all = [...this.items].sort()
    const statics = all.filter((item) => item.startsWith('static '))
    const plain = all.filter((item) => !item.startsWith('static '))
    const java = plain.filter((item) => item.startsWith('java.'))
    const others = plain.filter((item) => !item.startsWith('java.'))
    return [statics, java, others]
      .filter((group) => group.length > 0)
      .map((group) => group.map((item) => `import ${item};`).join('\n'))
      .join('\n\n')
  }
}

/** Fully qualified names of the classes generated for embedded objects and enums. */
export interface JavaTypeNames {
  object(name: string): string
  enum(name: string): string
}

/**
 * The Java type of an API type, always a reference type so it can be null.
 *
 * @param type The type.
 * @param imports Collects the imports the type needs.
 * @param names Qualified names of the embedded objects and enums.
 */
export function javaType(type: SpecType, imports: JavaImports, names: JavaTypeNames): string {
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string':
        case 'duration':
          return 'String'
        case 'integer':
          return type.bits === 64 ? 'Long' : 'Integer'
        case 'float':
          return 'Double'
        case 'decimal':
          imports.add('java.math.BigDecimal')
          return 'BigDecimal'
        case 'boolean':
          return 'Boolean'
        case 'date':
          imports.add('java.time.LocalDate')
          return 'LocalDate'
        case 'datetime':
          imports.add('java.time.OffsetDateTime')
          return 'OffsetDateTime'
        case 'time':
          imports.add('java.time.LocalTime')
          return 'LocalTime'
        case 'uuid':
          imports.add('java.util.UUID')
          return 'UUID'
        case 'binary':
          return 'byte[]'
        case 'any':
          return 'Object'
      }
      return 'Object'
    case 'array':
      imports.add('java.util.List')
      return `List<${javaType(type.items, imports, names)}>`
    case 'map':
      imports.add('java.util.Map')
      return `Map<String, ${javaType(type.value, imports, names)}>`
    case 'object': {
      const qualified = names.object(type.name)
      imports.add(qualified)
      return qualified.slice(qualified.lastIndexOf('.') + 1)
    }
    case 'enum': {
      const qualified = names.enum(type.name)
      imports.add(qualified)
      return qualified.slice(qualified.lastIndexOf('.') + 1)
    }
  }
}

/** A Javadoc comment, indented. */
export function javaDoc(text: string, indent = ''): string {
  const body = text.split('\n')
  if (body.length === 1) return `${indent}/** ${text} */`
  return [`${indent}/**`, ...body.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`].join('\n')
}
