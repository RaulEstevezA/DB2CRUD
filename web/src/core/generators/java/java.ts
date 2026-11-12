/**
 * What the Java generator needs: identifiers (camelCase members, PascalCase types, lowercase packages), Java
 * literals, and the imports of a compilation unit, sorted, without the ones of its own package or java.lang.
 */
import { splitWords, toCamelCase, toPascalCase } from '../../model/naming.ts'

const KEYWORDS = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends final ' +
    'finally float for goto if implements import instanceof int interface long native new package private protected ' +
    'public return short static strictfp super switch synchronized this throw throws transient try void volatile while ' +
    'true false null var record yield sealed permits'
  ).split(' '),
)

function safe(name: string): string {
  const base = /^[0-9]/.test(name) ? `_${name}` : name
  return KEYWORDS.has(base) ? `${base}_` : base
}

/** `created_at` → `createdAt`. */
export const memberName = (name: string) => safe(toCamelCase(name) || 'value')

/** `order line` → `OrderLine`. */
export const typeName = (name: string) => safe(toPascalCase(name) || 'Item')

/** `OrderLine` → `orderline`, for a package. */
export const packageName = (name: string) => safe(splitWords(name).join('').toLowerCase() || 'item')

/** `createdAt` → `CreatedAt`, for getters and setters. */
export const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** A Java string literal. */
export function javaString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

/** The path of a class of a package: `src/main/java/app/entities/Product.java`. */
export const javaPath = (pkg: string, name: string, test = false) =>
  `src/${test ? 'test' : 'main'}/java/${pkg.replace(/\./g, '/')}/${name}.java`

/** The imports of one compilation unit: static imports first, then the others, each sorted. */
export class JavaImports {
  private readonly names = new Set<string>()
  private readonly statics = new Set<string>()
  private readonly pkg: string

  constructor(pkg: string) {
    this.pkg = pkg
  }

  /** `import a.b.C;` for a fully qualified name. */
  add(...names: string[]): this {
    for (const name of names) this.names.add(name)
    return this
  }

  /** `import static a.b.C.member;` */
  addStatic(...names: string[]): this {
    for (const name of names) this.statics.add(name)
    return this
  }

  write(): string {
    const own = (name: string) => name.slice(0, name.lastIndexOf('.'))
    const names = [...this.names].filter((name) => own(name) !== this.pkg && own(name) !== 'java.lang').sort()
    const statics = [...this.statics].sort()
    const result = statics.map((name) => `import static ${name};`)
    if (statics.length > 0 && names.length > 0) result.push('')
    result.push(...names.map((name) => `import ${name};`))
    return result.join('\n')
  }
}
