/**
 * The expressions ORM code declares tables with, read from tokens into a small tree: names (`sa.String`), calls
 * with positional and named arguments (`mapped_column(String(120), nullable=False)`), texts, numbers, lists and
 * dictionaries, and attributes of what a call returns (`BigInteger().with_variant(…)`). It never evaluates
 * anything: the readers of each ORM look at the tree. What it does not know is kept as its text.
 */
import type { Cursor } from '../code/lexer.ts'

export type Expr =
  | { kind: 'name'; path: string[] }
  | { kind: 'call'; callee: Expr; args: Expr[]; named: Record<string, Expr> }
  | { kind: 'attribute'; target: Expr; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'dict'; entries: { key: Expr; value: Expr }[] }
  | { kind: 'other'; text: string }

export interface ExpressionSyntax {
  /** What separates a named argument from its value: `=` (Python, Java annotations) or `:` (PHP, C# attributes) */
  named: '=' | ':'
}

/** The tokens that end an expression at its level. */
const STOP = new Set([',', ')', ']', '}', ':', '=', ';'])

function isNamedArgument(cursor: Cursor, syntax: ExpressionSyntax): boolean {
  return cursor.isIdent() && cursor.is(syntax.named, 1) && !cursor.is('==', 1)
}

/** The arguments of a call, after its opening bracket and up to the closing one, which it reads too. */
export function readArguments(cursor: Cursor, source: string, syntax: ExpressionSyntax, close: string) {
  const args: Expr[] = []
  const named: Record<string, Expr> = {}
  while (!cursor.done && !cursor.is(close)) {
    if (isNamedArgument(cursor, syntax)) {
      const name = cursor.next().value
      cursor.next()
      named[name] = readExpression(cursor, source, syntax)
    } else if (cursor.is('*') || cursor.is('**')) {
      // Spread arguments are not followed
      cursor.next()
      readExpression(cursor, source, syntax)
    } else args.push(readExpression(cursor, source, syntax))
    if (!cursor.eat(',')) break
  }
  cursor.eat(close)
  return { args, named }
}

/** Whether the group at the cursor is the parameters of an arrow function: `=>` follows it, maybe after a type. */
function isArrow(cursor: Cursor): boolean {
  const start = cursor.index
  cursor.skipGroup()
  let arrow = cursor.is('=>')
  if (cursor.is(':')) {
    cursor.skipUntil(['=>', ',', ';'])
    arrow = cursor.is('=>')
  }
  cursor.index = start
  return arrow
}

function readPrimary(cursor: Cursor, source: string, syntax: ExpressionSyntax): Expr {
  const token = cursor.peek()
  if (!token) return { kind: 'other', text: '' }
  if (token.kind === 'string') {
    // Adjacent texts are one text: "a" "b"
    let value = ''
    while (cursor.peek()?.kind === 'string') value += cursor.next().value
    return { kind: 'string', value }
  }
  if (token.kind === 'number') {
    cursor.next()
    return { kind: 'number', value: Number(token.value.replace(/_/g, '').replace(/[lLfFdDmM]$/, '')) }
  }
  if (cursor.is('-') && cursor.peek(1)?.kind === 'number') {
    cursor.next()
    return { kind: 'number', value: -Number(cursor.next().value.replace(/_/g, '')) }
  }
  if (cursor.is('(') && isArrow(cursor)) {
    // An arrow function (`() => Order`, `(): AnyPgColumn => orders.id`) is kept as text
    const start = cursor.index
    cursor.skipUntil([',', ';'])
    return { kind: 'other', text: cursor.textBetween(source, start, cursor.index) }
  }
  if (cursor.is('[') || cursor.is('(')) {
    const close = cursor.is('[') ? ']' : ')'
    cursor.next()
    const items: Expr[] = []
    const entries: { key: Expr; value: Expr }[] = []
    while (!cursor.done && !cursor.is(close)) {
      const item = readExpression(cursor, source, syntax)
      // PHP arrays with keys: `['default' => 1]`
      if (close === ']' && cursor.eat('=>')) entries.push({ key: item, value: readExpression(cursor, source, syntax) })
      else items.push(item)
      if (!cursor.eat(',')) break
    }
    cursor.eat(close)
    if (entries.length > 0) return { kind: 'dict', entries }
    // A group of one is the expression itself: (x)
    return close === ')' && items.length === 1 ? items[0] : { kind: 'list', items }
  }
  if (cursor.is('{')) {
    cursor.next()
    const entries: { key: Expr; value: Expr }[] = []
    const items: Expr[] = []
    while (!cursor.done && !cursor.is('}')) {
      const key = readExpression(cursor, source, syntax)
      if (cursor.eat(':') || cursor.eat('=>')) entries.push({ key, value: readExpression(cursor, source, syntax) })
      else items.push(key)
      if (!cursor.eat(',')) break
    }
    cursor.eat('}')
    // Braces with no keys are a list: a Java array (`{ "a", "b" }`) or a Python set
    return entries.length === 0 && items.length > 0 ? { kind: 'list', items } : { kind: 'dict', entries }
  }
  if (cursor.is('@') && cursor.isIdent(1)) {
    // An annotation inside another (`indexes = { @Index(columnList = "a") }`) reads as a call
    cursor.next()
    return readPrimary(cursor, source, syntax)
  }
  // `new X(…)` reads as the call `X(…)`; `\\DateTime` (PHP) as `DateTime`
  if ((token.kind === 'ident' && token.value === 'new' && cursor.isIdent(1)) || (cursor.is('\\') && cursor.isIdent(1))) {
    cursor.next()
    return readPrimary(cursor, source, syntax)
  }
  if (token.kind === 'ident') {
    const path = [cursor.next().value]
    // `a.b`, `Types::BIGINT` (PHP), `ORM\\Column` (PHP namespaces)
    while ((cursor.is('.') || cursor.is('::') || cursor.is('\\')) && cursor.isIdent(1)) {
      cursor.next()
      path.push(cursor.next().value)
    }
    return { kind: 'name', path }
  }
  return { kind: 'other', text: '' }
}

/** Reads one expression at the cursor, up to a comma or a closing bracket of its level. */
export function readExpression(cursor: Cursor, source: string, syntax: ExpressionSyntax = { named: '=' }): Expr {
  const start = cursor.index
  let expr = readPrimary(cursor, source, syntax)
  for (;;) {
    if (cursor.is('(')) {
      cursor.next()
      const { args, named } = readArguments(cursor, source, syntax, ')')
      expr = { kind: 'call', callee: expr, args, named }
    } else if (cursor.is('.') && cursor.isIdent(1)) {
      cursor.next()
      expr = { kind: 'attribute', target: expr, name: cursor.next().value }
    } else if (
      cursor.peek()?.kind === 'string' &&
      source[cursor.peek()!.start] === '`' &&
      (expr.kind === 'name' || expr.kind === 'attribute')
    ) {
      // A tagged template (sql`now()`) is a call with its text
      expr = { kind: 'call', callee: expr, args: [{ kind: 'string', value: cursor.next().value }], named: {} }
    } else if (cursor.is('[')) {
      // Subscripts (Mapped[int]) are kept as text
      cursor.skipGroup()
      expr = { kind: 'other', text: cursor.textBetween(source, start, cursor.index) }
    } else break
  }
  // A literal before `=>` is the key of a PHP array, not the start of a lambda
  if ((expr.kind === 'string' || expr.kind === 'number') && cursor.is('=>')) return expr
  // Anything else up to the end of the expression (operators, lambdas) makes it text
  if (!cursor.done && !STOP.has(cursor.value()) && cursor.peek()!.kind === 'punct' && !cursor.peek()!.lineStart) {
    cursor.skipUntil([',', ';'])
    return { kind: 'other', text: cursor.textBetween(source, start, cursor.index) }
  }
  return expr
}

// Reading the tree

/** The name a name or a call goes by: `String` for `sa.String(120)`, `with_variant` for `x().with_variant()`. */
export function nameOf(expr: Expr | undefined): string | undefined {
  if (!expr) return undefined
  if (expr.kind === 'name') return expr.path.at(-1)
  if (expr.kind === 'call') return nameOf(expr.callee)
  if (expr.kind === 'attribute') return expr.name
  return undefined
}

/** The calls of a chain, innermost first: `BigInteger().with_variant(Integer(), "sqlite")` → BigInteger, with_variant. */
export function chainOf(expr: Expr): Expr[] {
  if (expr.kind === 'call' && expr.callee.kind === 'attribute') return [...chainOf(expr.callee.target), expr]
  if (expr.kind === 'attribute') return [...chainOf(expr.target), expr]
  return [expr]
}

export const stringOf = (expr: Expr | undefined): string | undefined => (expr?.kind === 'string' ? expr.value : undefined)
export const numberOf = (expr: Expr | undefined): number | undefined => (expr?.kind === 'number' ? expr.value : undefined)

/** `True`/`true` and `False`/`false`, or undefined for anything else. */
export function booleanOf(expr: Expr | undefined): boolean | undefined {
  if (expr?.kind !== 'name' || expr.path.length !== 1) return undefined
  const name = expr.path[0].toLowerCase()
  return name === 'true' ? true : name === 'false' ? false : undefined
}

/** A literal default: a text, a number or a boolean. */
export function literalOf(expr: Expr | undefined): string | number | boolean | undefined {
  return stringOf(expr) ?? numberOf(expr) ?? booleanOf(expr)
}

/** The expression as code, for the `sql` of a type and for notes. */
export function textOf(expr: Expr): string {
  switch (expr.kind) {
    case 'name':
      return expr.path.join('.')
    case 'string':
      return JSON.stringify(expr.value)
    case 'number':
      return String(expr.value)
    case 'call': {
      const args = [...expr.args.map(textOf), ...Object.entries(expr.named).map(([name, value]) => `${name}=${textOf(value)}`)]
      return `${textOf(expr.callee)}(${args.join(', ')})`
    }
    case 'attribute':
      return `${textOf(expr.target)}.${expr.name}`
    case 'list':
      return `[${expr.items.map(textOf).join(', ')}]`
    case 'dict':
      return `{${expr.entries.map((entry) => `${textOf(entry.key)}: ${textOf(entry.value)}`).join(', ')}}`
    case 'other':
      return expr.text
  }
}
