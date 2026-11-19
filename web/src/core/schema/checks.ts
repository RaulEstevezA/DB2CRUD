/**
 * The forms of a CHECK constraint the rules understand, read from its SQL text: a column in a list of values, a
 * column compared with a number, and the length of a column compared with a number. Anything else keeps only its
 * text. Shared by the readers of ORM code and of DDL, which find CHECKs as written.
 */
import type { CompareOp, DbCheck } from './types.ts'

const IDENT = String.raw`["\x60\[]?([A-Za-z_][A-Za-z0-9_]*)["\x60\]]?`
const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`
const OP = String.raw`(>=|<=|>|<)`

/** A value of an IN list: a quoted text (with '' for a quote) or a number. */
function listValues(list: string): (string | number)[] | null {
  const values: (string | number)[] = []
  const pattern = /\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?))\s*(?:,|$)/y
  let index = 0
  while (index < list.length) {
    pattern.lastIndex = index
    const match = pattern.exec(list)
    if (!match) return null
    values.push(match[1] !== undefined ? match[1].replace(/''/g, "'") : Number(match[2]))
    index = pattern.lastIndex
  }
  return values.length > 0 ? values : null
}

/** The comparison read the other way: `0 <= price` is `price >= 0`. */
const FLIPPED: Record<CompareOp, CompareOp> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' }

/** What a CHECK says, when it is a form the rules understand. Outer parentheses do not matter. */
export function parseCheck(sql: string): DbCheck['parsed'] {
  let text = sql.trim()
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim()
  let match = new RegExp(String.raw`^${IDENT}\s+IN\s*\((.*)\)$`, 'is').exec(text)
  if (match) {
    const values = listValues(match[2])
    return values ? { kind: 'in', column: match[1], values } : undefined
  }
  match = new RegExp(String.raw`^(?:LENGTH|CHAR_LENGTH|LEN)\s*\(\s*${IDENT}\s*\)\s*${OP}\s*${NUMBER}$`, 'i').exec(text)
  if (match) return { kind: 'length', column: match[1], op: match[2] as CompareOp, value: Number(match[3]) }
  match = new RegExp(String.raw`^${IDENT}\s*${OP}\s*${NUMBER}$`).exec(text)
  if (match) return { kind: 'compare', column: match[1], op: match[2] as CompareOp, value: Number(match[3]) }
  match = new RegExp(String.raw`^${NUMBER}\s*${OP}\s*${IDENT}$`).exec(text)
  if (match) return { kind: 'compare', column: match[3], op: FLIPPED[match[2] as CompareOp], value: Number(match[1]) }
  return undefined
}

/** A CHECK as written, with what it says when the rules understand it. */
export function checkOf(sql: string, name?: string): DbCheck {
  const parsed = parseCheck(sql)
  return { ...(name ? { name } : {}), sql, ...(parsed ? { parsed } : {}) }
}
