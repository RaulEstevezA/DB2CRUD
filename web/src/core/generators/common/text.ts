/**
 * Text helpers shared by the generators: joining lines while skipping the ones that do not apply, and
 * indenting blocks of code.
 */

/** A line, or `false` / `null` / `undefined` for a line that does not apply. */
export type Line = string | false | null | undefined

/** Lines, possibly grouped in nested lists. */
export type Lines = Line | Lines[]

/** Joins the lines that apply with line breaks, at any depth of nesting. */
export function lines(...items: Lines[]): string {
  const result: string[] = []
  const add = (item: Lines) => {
    if (Array.isArray(item)) item.forEach(add)
    else if (typeof item === 'string') result.push(item)
  }
  items.forEach(add)
  return result.join('\n')
}

/** Indents every non-empty line of a block. */
export function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n')
}

/** Ends a file with exactly one line break, as editors and linters expect. */
export function fileText(text: string): string {
  return `${text.replace(/\s+$/, '')}\n`
}

/**
 * Orders two texts the same way on every system: ignoring case first, then by character code. Used
 * instead of `localeCompare`, whose order depends on the language of the browser.
 */
export function compareText(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}
