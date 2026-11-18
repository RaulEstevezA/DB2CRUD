/**
 * What the Kotlin generator needs: identifiers (PascalCase classes, camelCase members), Kotlin literals, and the
 * imports of a file, sorted, without the ones of its own package.
 */
import { toCamelCase, toPascalCase } from '../../model/naming.ts'

/** Hard keywords of Kotlin: a name that is one of them goes between backticks. */
const KEYWORDS = new Set(
  'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(
    ' ',
  ),
)

/** A member or variable name: `order_id` → `orderId`; a keyword goes between backticks. */
export const memberName = (name: string) => {
  const base = toCamelCase(name) || 'value'
  const safe = /^[0-9]/.test(base) ? `_${base}` : base
  return KEYWORDS.has(safe) ? `\`${safe}\`` : safe
}

/** `order line` → `OrderLine`. */
export const typeName = (name: string) => {
  const base = toPascalCase(name) || 'Item'
  return /^[0-9]/.test(base) ? `_${base}` : base
}

/** A Kotlin string literal; `$` is escaped so nothing is interpolated. */
export function ktString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

/** The imports of one file, sorted, without the classes of its own package. */
export class KtImports {
  private readonly names = new Set<string>()
  private readonly pkg: string

  constructor(pkg: string) {
    this.pkg = pkg
  }

  add(...names: string[]): this {
    for (const name of names) this.names.add(name)
    return this
  }

  write(): string {
    const own = (name: string) => name.slice(0, name.lastIndexOf('.')) === this.pkg
    return [...this.names]
      .filter((name) => !own(name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => `import ${name}`)
      .join('\n')
  }
}
