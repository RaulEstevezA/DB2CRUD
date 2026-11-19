/**
 * Reads SQLModel models: SQLAlchemy underneath, so it is the SQLAlchemy reader with SQLModel's way of declaring.
 * A class is a table when it says `table=True` (named by `__tablename__`, or by the class in lower case), every
 * annotated attribute is a column, and `Field(...)` says what `mapped_column(...)` says with other names
 * (`foreign_key`, `max_length`, `sa_type`, `sa_column_kwargs`), or hands over a whole `Column` in `sa_column`.
 */
import { booleanOf, nameOf, numberOf, stringOf, type Expr } from './expressions.ts'
import { readDeclarative, type Flavour } from './sqlalchemy.ts'
import type { OrmReader } from './types.ts'

type Call = Expr & { kind: 'call' }

const call = (name: string, args: Expr[] = [], named: Record<string, Expr> = {}): Call => ({
  kind: 'call',
  callee: { kind: 'name', path: [name] },
  args,
  named,
})

/** What `Field(...)` says about the type when the annotation alone does not: a length, digits. */
function typeOfField(named: Record<string, Expr>, annotation: string): Expr | undefined {
  if (named.sa_type) return named.sa_type
  const python = annotation
    .replace(/Optional\[(.*)\]/s, '$1')
    .replace(/\|\s*None|None\s*\|/g, '')
    .trim()
  if (python === 'str' && numberOf(named.max_length) !== undefined) return call('String', [named.max_length])
  if (/^(decimal\.)?Decimal$/.test(python) && numberOf(named.max_digits) !== undefined)
    return call('Numeric', [named.max_digits, ...(named.decimal_places ? [named.decimal_places] : [])])
  return undefined
}

/** The value the application gives an attribute left out: `default` or `default_factory`. `default=None` only says
 * the attribute may be left out. */
function defaultOf(field: Call): Expr | undefined {
  const value = field.named.default ?? field.named.default_factory
  return value && !(value.kind === 'name' && value.path.join('.') === 'None') ? value : undefined
}

/** `Field(...)` as the `mapped_column(...)` that says the same. */
function fieldAsColumn(field: Call, annotation: string): Call {
  const named = field.named
  const args: Expr[] = []
  const type = typeOfField(named, annotation)
  if (type) args.push(type)
  const reference = stringOf(named.foreign_key)
  if (reference !== undefined)
    args.push(call('ForeignKey', [{ kind: 'string', value: reference }], named.ondelete ? { ondelete: named.ondelete } : {}))
  const column: Record<string, Expr> = {}
  for (const key of ['primary_key', 'nullable', 'unique', 'index']) if (named[key]) column[key] = named[key]
  const value = defaultOf(field)
  if (value) column.default = value
  const extra = named.sa_column_kwargs
  if (extra?.kind === 'dict')
    for (const entry of extra.entries) {
      const key = stringOf(entry.key)
      if (key) column[key] = entry.value
    }
  return call('mapped_column', args, column)
}

const isClassVar = (annotation: string) => /^\s*(typing\.)?ClassVar\b/.test(annotation)

const SQLMODEL: Flavour = {
  format: 'sqlmodel',
  tableOf: (def, tablename) => (booleanOf(def.keywords.table) === true ? (tablename ?? def.name.toLowerCase()) : null),
  columnOf(value, annotation) {
    // Every annotated attribute is a column, except relationships and class variables
    if (!annotation || isClassVar(annotation) || nameOf(value ?? undefined) === 'Relationship') return null
    if (value?.kind === 'call' && nameOf(value) === 'Field') {
      const column = value.named.sa_column
      // A whole Column: SQLModel uses it as it is, with the default of the Field when it has none
      if (column?.kind === 'call' && nameOf(column) === 'Column') {
        const fieldDefault = defaultOf(value)
        const withDefault =
          fieldDefault && !column.named.default ? { ...column, named: { ...column.named, default: fieldDefault } } : column
        return { call: withDefault, classic: true, annotation: '' }
      }
      return { call: fieldAsColumn(value, annotation), classic: false, annotation }
    }
    const field = value === null ? call('Field') : call('Field', [], { default: value })
    return { call: fieldAsColumn(field, annotation), classic: false, annotation }
  },
  relationshipOf(value) {
    if (value?.kind !== 'call' || nameOf(value) !== 'Relationship' || value.named.link_model) return null
    const options = value.named.sa_relationship_kwargs
    const foreignKeys =
      options?.kind === 'dict' ? options.entries.find((entry) => stringOf(entry.key) === 'foreign_keys')?.value : undefined
    return { call: value, ...(foreignKeys ? { foreignKeys } : {}) }
  },
}

export const sqlmodelReader: OrmReader = {
  id: 'sqlmodel',
  label: 'SQLModel',
  language: 'python',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\b(from|import)\s+sqlmodel\b/.test(text) ? 1 : 0
  },
  read: (files) => readDeclarative(files, SQLMODEL),
}
