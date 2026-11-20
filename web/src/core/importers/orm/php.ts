/**
 * The declarations of PHP files the readers of PHP ORMs need: classes (and enums, traits, interfaces) with their
 * attributes, base class, properties (type, attributes, initial value), constants, enum cases and what each method
 * returns. It never runs anything: it reads the tokens.
 */
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { PHP_LEXER } from '../code/php.ts'
import { literalOf, nameOf, readExpression, stringOf, type Expr } from './expressions.ts'
import type { SourceFile } from './types.ts'

/** PHP names its arguments with `name: value`. */
export const SYNTAX = { named: ':' } as const

export interface Property {
  /** Without its `$` */
  name: string
  /** The PHP type as written: `?int`, `\DateTimeImmutable` */
  type: string
  attributes: Expr[]
  initializer?: Expr
  line: number
}

export interface PhpClass {
  name: string
  kind: string
  attributes: Expr[]
  base?: string
  properties: Property[]
  /** The constants of the class: `const NAME = 'precise_datetime'` */
  constants: Map<string, Expr>
  /** The cases of an enum, with their values when it is backed */
  cases: { name: string; value?: string | number }[]
  /** The methods, with what each returns: `casts()` returns the casts, `customer()` a relation */
  methods: { name: string; returns: Expr[] }[]
  line: number
}

// Reading the declarations

/** The attributes of a `#[…]` group, after its `#[`. */
function readAttributeGroup(cursor: Cursor, source: string): Expr[] {
  const attributes: Expr[] = []
  while (!cursor.done && !cursor.is(']')) {
    attributes.push(readExpression(cursor, source, SYNTAX))
    if (!cursor.eat(',')) break
  }
  cursor.eat(']')
  return attributes
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'var', 'final', 'abstract'])
const DECLARATIONS = new Set(['class', 'interface', 'trait', 'enum'])

function readDeclaration(cursor: Cursor, source: string, kind: string, attributes: Expr[], classes: PhpClass[]): void {
  const line = cursor.peek()?.line ?? 1
  const declaration: PhpClass = {
    name: cursor.next().value,
    kind,
    attributes,
    properties: [],
    constants: new Map(),
    cases: [],
    methods: [],
    line,
  }
  while (!cursor.done && !cursor.is('{')) {
    if (cursor.is('extends') && cursor.isIdent(1)) {
      cursor.next()
      while (cursor.is('\\')) cursor.next()
      let base = cursor.next().value
      while (cursor.is('\\') && cursor.isIdent(1)) {
        cursor.next()
        base = cursor.next().value
      }
      declaration.base = base
    } else cursor.next()
  }
  classes.push(declaration)
  cursor.next()
  let pending: Expr[] = []
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is('#[')) {
      cursor.next()
      pending.push(...readAttributeGroup(cursor, source))
      continue
    }
    if (MODIFIERS.has(cursor.value()) && cursor.isIdent()) {
      cursor.next()
      continue
    }
    if (cursor.is('case') && cursor.isIdent(1)) {
      cursor.next()
      const name = cursor.next().value
      const value = cursor.eat('=') ? literalOf(readExpression(cursor, source, SYNTAX)) : undefined
      declaration.cases.push({ name, ...(typeof value === 'string' || typeof value === 'number' ? { value } : {}) })
      cursor.skipUntil([';'])
      cursor.eat(';')
      pending = []
      continue
    }
    if (cursor.is('const')) {
      cursor.next()
      // `const string NAME = …` (PHP 8.3 typed constants)
      if (cursor.isIdent(1) && !cursor.is('=', 1)) cursor.next()
      const name = cursor.next().value
      if (cursor.eat('=')) declaration.constants.set(name, readExpression(cursor, source, SYNTAX))
      cursor.skipUntil([';'])
      cursor.eat(';')
      pending = []
      continue
    }
    if (cursor.is('function')) {
      // A method: its parameters, its return type and its body, with what it returns
      cursor.next()
      const name = cursor.isIdent() ? cursor.value() : ''
      while (!cursor.done && !cursor.is('(')) cursor.next()
      cursor.skipGroup()
      while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('}')) cursor.next()
      const returns: Expr[] = []
      if (cursor.is('{')) {
        const start = cursor.index
        cursor.skipGroup()
        const end = cursor.index
        for (let index = start; index < end; index++)
          if (cursor.tokens[index].kind === 'ident' && cursor.tokens[index].value === 'return') {
            cursor.index = index + 1
            returns.push(readExpression(cursor, source, SYNTAX))
          }
        cursor.index = end
      } else cursor.eat(';')
      declaration.methods.push({ name, returns })
      pending = []
      continue
    }
    if (cursor.is('use')) {
      cursor.skipUntil([';'])
      cursor.eat(';')
      continue
    }
    // A property: an optional type, then `$name`
    const typeStart = cursor.index
    while (!cursor.done && !(cursor.isIdent() && cursor.value().startsWith('$')) && !cursor.is(';') && !cursor.is('}')) cursor.next()
    if (!cursor.isIdent() || !cursor.value().startsWith('$')) {
      cursor.eat(';')
      pending = []
      continue
    }
    const type = cursor.textBetween(source, typeStart, cursor.index).replace(/\s+/g, '')
    const name = cursor.next()
    const initializer = cursor.eat('=') ? readExpression(cursor, source, SYNTAX) : undefined
    cursor.skipUntil([';'])
    cursor.eat(';')
    declaration.properties.push({
      name: name.value.slice(1),
      type,
      attributes: pending,
      ...(initializer ? { initializer } : {}),
      line: name.line,
    })
    pending = []
  }
  cursor.eat('}')
}

/** The classes, interfaces, traits and enums of every file, in order. */
export function readClasses(files: SourceFile[]): PhpClass[] {
  const classes: PhpClass[] = []
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(
        file.text.replace(/^\s*<\?php/, (match) => ' '.repeat(match.length)),
        PHP_LEXER,
      )
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    let attributes: Expr[] = []
    while (!cursor.done) {
      if (cursor.is('#[')) {
        cursor.next()
        attributes.push(...readAttributeGroup(cursor, file.text))
      } else if (DECLARATIONS.has(cursor.value()) && cursor.isIdent() && cursor.isIdent(1)) {
        const kind = cursor.next().value
        readDeclaration(cursor, file.text, kind, attributes, classes)
        attributes = []
      } else if (MODIFIERS.has(cursor.value()) && cursor.isIdent()) cursor.next()
      else {
        cursor.next()
        attributes = []
      }
    }
  }
  return classes
}

/** `Order::class` or `'App\Entity\Order'`: the class it names, without its namespace. */
export function classOf(expr: Expr | undefined): string | undefined {
  if (!expr) return undefined
  if (expr.kind === 'name' && expr.path.at(-1) === 'class') return expr.path.at(-2)
  const text = stringOf(expr)
  return text?.split('\\').at(-1)
}

/** The entries of a PHP array with keys: `['default' => 1]`. */
export function entriesOf(expr: Expr | undefined): Map<string, Expr> {
  const entries = new Map<string, Expr>()
  if (expr?.kind === 'dict')
    for (const entry of expr.entries) {
      const key = stringOf(entry.key) ?? nameOf(entry.key)
      if (key) entries.set(key, entry.value)
    }
  return entries
}
