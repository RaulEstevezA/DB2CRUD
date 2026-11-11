/**
 * What PHP generators need (Laravel, and Symfony after it): class and variable names, string and value
 * literals, the `use` statements of a file and documentation comments.
 */
import { toCamelCase, toPascalCase, toSnakeCase } from '../../../model/naming.ts'
import type { JsonValue } from '../../common/samples.ts'
import { compareText } from '../../common/text.ts'

/** Words PHP does not allow as class names, compared without case. */
const RESERVED_CLASSES = new Set([
  'abstract',
  'and',
  'array',
  'as',
  'bool',
  'break',
  'callable',
  'case',
  'catch',
  'class',
  'clone',
  'const',
  'continue',
  'declare',
  'default',
  'do',
  'echo',
  'else',
  'elseif',
  'empty',
  'enum',
  'eval',
  'exit',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'fn',
  'for',
  'foreach',
  'function',
  'global',
  'goto',
  'if',
  'implements',
  'include',
  'instanceof',
  'insteadof',
  'int',
  'interface',
  'isset',
  'iterable',
  'list',
  'match',
  'mixed',
  'namespace',
  'never',
  'new',
  'null',
  'object',
  'or',
  'parent',
  'print',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'self',
  'static',
  'string',
  'switch',
  'throw',
  'trait',
  'true',
  'try',
  'unset',
  'use',
  'var',
  'void',
  'while',
  'xor',
  'yield',
])

/** A PascalCase class name; a word PHP reserves gets `Item` after it (`List` → `ListItem`). */
export function phpClass(name: string): string {
  const pascal = toPascalCase(name) || 'Model'
  const safe = /^[0-9]/.test(pascal) ? `_${pascal}` : pascal
  return RESERVED_CLASSES.has(safe.toLowerCase()) ? `${safe}Item` : safe
}

/** A camelCase name for variables, properties and methods (PHP allows reserved words there). */
export function phpName(name: string): string {
  const camel = toCamelCase(name) || 'value'
  return /^[0-9]/.test(camel) ? `_${camel}` : camel
}

/** A snake_case name for database tables and columns: `postalCode` → `postal_code`. */
export function phpSnake(name: string): string {
  return toSnakeCase(name) || 'value'
}

/** A string literal with single quotes, where only `\` and `'` are escaped. */
export function phpString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** A JSON value as a PHP literal: objects and lists are arrays. */
export function phpLiteral(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') return phpString(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(phpLiteral).join(', ')}]`
  const entries = Object.entries(value).map(([key, item]) => `${phpString(key)} => ${phpLiteral(item)}`)
  return `[${entries.join(', ')}]`
}

/** The `use` statements of a file, sorted, without the classes of the file's own namespace. */
export class PhpImports {
  private readonly names = new Set<string>()
  private readonly namespace: string

  constructor(namespace: string) {
    this.namespace = namespace
  }

  add(...classes: string[]): this {
    for (const name of classes) {
      if (name.slice(0, name.lastIndexOf('\\')) !== this.namespace) this.names.add(name)
    }
    return this
  }

  render(): string {
    return [...this.names]
      .sort(compareText)
      .map((name) => `use ${name};`)
      .join('\n')
  }
}

/** A documentation comment, indented. */
export function phpDoc(text: string, indent = ''): string {
  const body = text.split('\n')
  if (body.length === 1) return `${indent}/** ${text} */`
  return [`${indent}/**`, ...body.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`].join('\n')
}

/** The opening of a PHP file in a namespace, with its `use` statements. */
export function phpHeader(namespace: string, imports: PhpImports): string[] {
  const uses = imports.render()
  return ['<?php', '', `namespace ${namespace};`, '', ...(uses ? [uses, ''] : [])]
}

/** A PCRE pattern for Laravel's `regex` rule: the source between delimiters, Unicode aware. */
export function phpRegex(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      // An escape is copied whole, so an already escaped "/" stays as it is
      source += char + (pattern[index + 1] ?? '')
      index++
    } else source += char === '/' ? '\\/' : char
  }
  return `/${source}/u`
}
