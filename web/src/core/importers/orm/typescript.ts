/**
 * The declarations of TypeScript modules the readers of TypeScript ORMs need: classes with their decorators, their
 * base class and their members (name, type as written, decorators), and enums with the value of each member. It
 * never runs anything: it reads the tokens.
 */
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import { literalOf, readArguments, readExpression, type Expr } from './expressions.ts'
import type { SourceFile } from './types.ts'

/** TypeScript has no named arguments: `=` never separates one. */
export const SYNTAX = { named: '=' } as const

export interface Decorator {
  name: string
  args: Expr[]
}

export interface Member {
  name: string
  /** The TypeScript type as written: `string | null` */
  type: string
  decorators: Decorator[]
  line: number
}

export interface ClassDef {
  name: string
  base?: string
  decorators: Decorator[]
  members: Member[]
  line: number
}

// Reading the declarations

export function readDecorator(cursor: Cursor, source: string): Decorator {
  const parts = [cursor.next().value]
  while (cursor.is('.') && cursor.isIdent(1)) {
    cursor.next()
    parts.push(cursor.next().value)
  }
  if (!cursor.is('(')) return { name: parts.at(-1)!, args: [] }
  cursor.next()
  return { name: parts.at(-1)!, args: readArguments(cursor, source, SYNTAX, ')').args }
}

/** Moves past the rest of a statement: up to a `;`, a new line or the `}` that closes its block. */
function skipStatement(cursor: Cursor): void {
  const start = cursor.index
  while (!cursor.done) {
    const token = cursor.peek()!
    if (cursor.index > start && token.lineStart) return
    if (token.kind === 'punct' && token.value === '}') return
    if (token.kind === 'punct' && token.value === ';') {
      cursor.next()
      return
    }
    if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) cursor.skipGroup()
    else cursor.next()
  }
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'readonly',
  'declare',
  'static',
  'abstract',
  'override',
  'accessor',
  'get',
  'set',
  'async',
])

function readClassBody(cursor: Cursor, source: string): Member[] {
  const members: Member[] = []
  let decorators: Decorator[] = []
  cursor.next()
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is('@') && cursor.isIdent(1)) {
      cursor.next()
      decorators.push(readDecorator(cursor, source))
      continue
    }
    if (cursor.is(';') || cursor.is(',')) {
      cursor.next()
      continue
    }
    while (MODIFIERS.has(cursor.value()) && cursor.isIdent() && (cursor.isIdent(1) || cursor.peek(1)?.kind === 'string')) cursor.next()
    if (!cursor.isIdent() && cursor.peek()?.kind !== 'string') {
      if (cursor.is('(') || cursor.is('[') || cursor.is('{')) cursor.skipGroup()
      else cursor.next()
      decorators = []
      continue
    }
    const name = cursor.next()
    cursor.eat('!')
    cursor.eat('?')
    // `name?: Type` reads `?:` as one token
    const typed = cursor.eat(':') || cursor.eat('?:')
    if (!typed && (cursor.is('(') || cursor.is('<'))) {
      // A method: its parameters, its return type and its body
      while (!cursor.done && !cursor.is('(')) cursor.next()
      cursor.skipGroup()
      while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('}')) cursor.next()
      if (cursor.is('{')) cursor.skipGroup()
      decorators = []
      continue
    }
    let type = ''
    if (typed) {
      const start = cursor.index
      while (!cursor.done) {
        const token = cursor.peek()!
        if (cursor.index > start && token.lineStart) break
        if (token.kind === 'punct' && (token.value === ';' || token.value === '=' || token.value === '}')) break
        if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) cursor.skipGroup()
        else cursor.next()
      }
      type = cursor.textBetween(source, start, cursor.index)
    }
    if (cursor.eat('=')) skipStatement(cursor)
    members.push({ name: name.value, type, decorators, line: name.line })
    decorators = []
  }
  cursor.eat('}')
  return members
}

/** The value of each member of a TypeScript enum: a text, or a number counted on from the last one. */
export type EnumDef = Map<string, string | number>

function readEnum(cursor: Cursor, source: string): EnumDef {
  const members: EnumDef = new Map()
  let next = 0
  cursor.next()
  while (!cursor.done && !cursor.is('}')) {
    if (!cursor.isIdent() && cursor.peek()?.kind !== 'string') {
      cursor.next()
      continue
    }
    const name = cursor.next().value
    if (cursor.eat('=')) {
      const value = literalOf(readExpression(cursor, source, SYNTAX))
      if (typeof value === 'number') next = value
      members.set(name, typeof value === 'string' ? value : next)
    } else members.set(name, next)
    next++
    cursor.eat(',')
  }
  cursor.eat('}')
  return members
}

/** The classes (by name, and in the order of the files) and the enums of every file. */
export function readTypeScript(files: SourceFile[]) {
  const classes = new Map<string, ClassDef>()
  const enums = new Map<string, EnumDef>()
  const order: ClassDef[] = []
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, TYPESCRIPT_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    let pending: Decorator[] = []
    while (!cursor.done) {
      if (cursor.is('@') && cursor.isIdent(1)) {
        cursor.next()
        pending.push(readDecorator(cursor, file.text))
      } else if (cursor.is('enum') && cursor.isIdent(1) && cursor.is('{', 2)) {
        cursor.next()
        const name = cursor.next().value
        enums.set(name, readEnum(cursor, file.text))
        pending = []
      } else if (cursor.is('class') && cursor.isIdent(1)) {
        const line = cursor.next().line
        const def: ClassDef = { name: cursor.next().value, decorators: pending, members: [], line }
        while (!cursor.done && !cursor.is('{')) {
          if (cursor.is('extends') && cursor.isIdent(1)) {
            cursor.next()
            def.base = cursor.next().value
          } else cursor.next()
        }
        def.members = readClassBody(cursor, file.text)
        classes.set(def.name, def)
        order.push(def)
        pending = []
      } else if (['export', 'default', 'abstract', 'declare', 'const'].includes(cursor.value()) && cursor.isIdent()) cursor.next()
      else {
        pending = []
        if (cursor.is('(') || cursor.is('[') || cursor.is('{')) cursor.skipGroup()
        else cursor.next()
      }
    }
  }
  return { classes, enums, order }
}

/** The type of a member without `| null` or `| undefined`. */
export const plainType = (member: Member) => member.type.replace(/\|\s*(null|undefined)\b/g, '').trim()
