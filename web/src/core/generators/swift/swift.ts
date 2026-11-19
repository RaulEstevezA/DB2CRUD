/**
 * What the Swift generator needs: identifiers (camelCase members, PascalCase types), Swift string literals, and the
 * imports of a file, sorted.
 */
import { toCamelCase, toPascalCase } from '../../model/naming.ts'

/** Keywords Swift reserves in declarations and expressions: a name that is one of them goes between backticks. */
const KEYWORDS = new Set(
  'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while Any as await false is nil self Self super throws true try'.split(
    ' ',
  ),
)

/** A property, variable or function name: `order_id` → `orderId`; a keyword goes between backticks. */
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

/** A Swift string literal; `\(` is escaped so nothing is interpolated. */
export function swString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

/** The import lines of a file, sorted. */
export const imports = (...modules: string[]) =>
  [...new Set(modules)]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((module) => `import ${module}`)
    .join('\n')
