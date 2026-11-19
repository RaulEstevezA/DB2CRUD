/**
 * What every reader of Python ORM code needs: the statements of a module (by indentation), its classes with their
 * bases and keywords, assignments with their annotations, enum classes, and the attributes a class inherits.
 */
import type { DbTable } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { PYTHON_LEXER } from '../code/python.ts'
import { literalOf, nameOf, readExpression, textOf, type Expr } from './expressions.ts'
import type { SourceFile } from './types.ts'

export interface Statement {
  tokens: Token[]
  source: string
}

/** The statements of a block: a new one starts on a line at the block's indentation, outside any bracket. */
export function statementsOf(tokens: Token[], source: string): Statement[] {
  if (tokens.length === 0) return []
  const indent = tokens[0].column
  const statements: Statement[] = []
  let current: Token[] = []
  let depth = 0
  for (const token of tokens) {
    if (token.lineStart && depth === 0 && token.column <= indent && current.length > 0) {
      statements.push({ tokens: current, source })
      current = []
    }
    current.push(token)
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth++
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1)
    }
  }
  if (current.length > 0) statements.push({ tokens: current, source })
  return statements
}

export interface ClassDef {
  name: string
  bases: string[]
  /** `table=True` in `class Book(SQLModel, table=True)` */
  keywords: Record<string, Expr>
  body: Statement[]
  line: number
  /** The file it is declared in */
  file: string
}

/** `class Name(Base, Mixin):` and the statements of its body. */
export function classOf(statement: Statement, file = ''): ClassDef | null {
  const cursor = new Cursor(statement.tokens)
  if (!cursor.is('class') || !cursor.isIdent(1)) return null
  cursor.next()
  const name = cursor.next().value
  const bases: string[] = []
  const keywords: Record<string, Expr> = {}
  if (cursor.eat('(')) {
    while (!cursor.done && !cursor.is(')')) {
      if (cursor.isIdent() && cursor.is('=', 1)) {
        const keyword = cursor.next().value
        cursor.next()
        keywords[keyword] = readExpression(cursor, statement.source)
      } else {
        const text = textOf(readExpression(cursor, statement.source))
        if (text) bases.push(text)
      }
      if (!cursor.eat(',')) break
    }
    cursor.eat(')')
  }
  cursor.eat(':')
  const body = statementsOf(statement.tokens.slice(cursor.index), statement.source)
  return { name, bases, keywords, body, line: statement.tokens[0].line, file }
}

export interface Assignment {
  name: string
  annotation: string
  value: Expr | null
}

/** `name: Annotation = value` or `name = value`: the parts of an assignment. */
export function assignmentOf(statement: Statement): Assignment | null {
  const cursor = new Cursor(statement.tokens)
  if (!cursor.isIdent()) return null
  const name = cursor.next().value
  let annotation = ''
  if (cursor.eat(':')) {
    const start = cursor.index
    cursor.skipUntil(['='])
    annotation = cursor.textBetween(statement.source, start, cursor.index)
  }
  if (!cursor.eat('=')) return annotation ? { name, annotation, value: null } : null
  return { name, annotation, value: readExpression(cursor, statement.source) }
}

export interface EnumClass {
  name: string
  /** Member names and their values, in order */
  members: { name: string; value: string | number }[]
}

/** `class OrderStatus(enum.Enum):` or Django's `class OrderStatus(models.TextChoices):`, and its members; a member
 * `PAID = "paid", "Paid"` has its label after the value. */
function enumClassOf(def: ClassDef): EnumClass | null {
  if (!def.bases.some((base) => /(^|\.)(Enum|IntEnum|StrEnum|TextChoices|IntegerChoices|Choices)$/.test(base))) return null
  const members: EnumClass['members'] = []
  for (const statement of def.body) {
    const item = assignmentOf(statement)
    const value = literalOf(item?.value ?? undefined)
    if (item && !item.name.startsWith('_') && (typeof value === 'string' || typeof value === 'number'))
      members.push({ name: item.name, value })
  }
  return { name: def.name, members }
}

/** The attributes of a class and of the classes it inherits from in the files when `inherits` says so (mixins,
 * abstract models, SQLModel's base models; not a base that is a table of its own), those of the bases first; an
 * attribute declared again keeps its place and takes the new value. */
export function attributesOf(
  def: ClassDef,
  classes: Map<string, ClassDef>,
  inherits: (base: ClassDef) => boolean,
  seen = new Set<string>(),
): Assignment[] {
  seen.add(def.name)
  const inherited = def.bases
    .map((base) => classes.get(base.split('.').at(-1)!))
    .filter((base): base is ClassDef => base !== undefined && !seen.has(base.name) && inherits(base))
    .flatMap((base) => attributesOf(base, classes, inherits, seen))
  const result: Assignment[] = []
  for (const item of [...inherited, ...def.body.map(assignmentOf)]) {
    if (!item) continue
    const index = result.findIndex((other) => other.name === item.name)
    if (index >= 0) result[index] = item
    else result.push(item)
  }
  return result
}

export function emptyTable(name: string, line: number): DbTable {
  return { name, columns: [], primaryKey: null, foreignKeys: [], uniques: [], indexes: [], checks: [], origin: { line, column: 1 } }
}

/** The statements of each file, its classes and its enums by name (enums first: a column may name one declared further
 * down). */
export function readModules(files: SourceFile[]): { modules: Statement[][]; classes: ClassDef[]; enums: Map<string, EnumClass> } {
  const modules = files.map((file) => statementsOf(tokenize(file.text, PYTHON_LEXER), file.text))
  const classes: ClassDef[] = []
  const enums = new Map<string, EnumClass>()
  modules.forEach((statements, index) => {
    for (const statement of statements) {
      const def = classOf(statement, files[index].name)
      if (!def) continue
      const enumClass = enumClassOf(def)
      if (enumClass) enums.set(enumClass.name, enumClass)
      else classes.push(def)
    }
  })
  return { modules, classes, enums }
}

/** A call that gives the current time: `func.now()`, `datetime.now`, `timezone.now`. */
export const isNow = (expr: Expr | undefined) =>
  expr !== undefined &&
  ['now', 'current_timestamp', 'utcnow', 'localtimestamp', 'current_date', 'today'].includes(nameOf(expr)?.toLowerCase() ?? '')

/** A call that gives a new UUID: `uuid.uuid4`, `gen_random_uuid()`. */
export const isUuid = (expr: Expr | undefined) =>
  expr !== undefined && /^uuid[147]$|^uuid_generate_v4$|^gen_random_uuid$/.test(nameOf(expr) ?? '')
