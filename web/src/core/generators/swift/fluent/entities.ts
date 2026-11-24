/**
 * The entity of each table (a plain struct with a property per column, every one of them nil until it is set) and its
 * Fluent model, which maps the table's exact name and columns: a column with `@Field`, or `@OptionalField` when it
 * takes null, and the key with `@ID`, or `@CompositeID` when it has several columns. Fluent reads and writes rows
 * through the model; the repositories turn models into entities and back. The constraints of the table (unique values,
 * foreign keys, defaults, CHECKs) live in the database: the tests create them, and the services check the values.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { fileOf, swFile, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { imports, swString } from '../swift.ts'

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const comment = info.table.comment ? `: ${info.table.comment}` : ''
  return swFile(fileOf(context, info, 'entity', info.entity), imports('Foundation'), [
    `/// A row of the "${info.name}" table${comment}. A property stays nil until it is set or read.`,
    `public struct ${info.entity}: Sendable, Equatable {`,
    ...info.columns.map((column) => `    public var ${column.prop}: ${column.sw}?`),
    '',
    `    public init(${info.columns.map((column) => `${column.prop}: ${column.sw}? = nil`).join(', ')}) {`,
    ...info.columns.map((column) => `        self.${column.prop} = ${column.prop}`),
    '    }',
    '}',
  ])
}

/** Columns a database can index whole: not text or bytes without a length (MySQL cannot key those). */
const indexable = (column: ColumnInfo) => {
  const type = column.column.type
  if (type.kind === 'text' || type.kind === 'binary') return type.length !== undefined
  return !['json', 'array', 'unknown'].includes(type.kind)
}

/**
 * The columns the model keys a table by: its primary key, or, when it has none, the columns that cannot be null and
 * can be indexed (or, failing those, every column that cannot be null). Fluent needs a key.
 */
export function mappedKey(info: TableInfo): ColumnInfo[] {
  if (info.table.primaryKey) return info.key
  const set = info.columns.filter((column) => !column.column.nullable)
  const keyable = set.filter(indexable)
  if (keyable.length > 0) return keyable
  return set.length > 0 ? set : info.columns
}

/** Whether the model keys the table by one column, named `id` in the model whatever its name in the table. */
export const singleKey = (info: TableInfo) => mappedKey(info).length === 1

/** How code reads a column of a model: `model.email`, the key `model.id`, or a part of it `model.id?.line`. */
export function modelValue(info: TableInfo, column: ColumnInfo, variable = 'model'): string {
  const key = mappedKey(info)
  if (!key.includes(column)) return `${variable}.${column.prop}`
  return key.length === 1 ? `${variable}.id` : `${variable}.id?.${column.prop}`
}

/** The key path of a column of a model, for filters and sorts: `\.$email`, `\.$id`, `\.$id.$line`. */
export function modelPath(info: TableInfo, column: ColumnInfo): string {
  const key = mappedKey(info)
  if (!key.includes(column)) return `\\.$${column.prop.replace(/`/g, '')}`
  return key.length === 1 ? '\\.$id' : `\\.$id.$${column.prop.replace(/`/g, '')}`
}

const field = (column: ColumnInfo) =>
  column.column.nullable
    ? [`@OptionalField(key: ${swString(column.column.name)})`, `var ${column.prop}: ${column.sw}?`]
    : [`@Field(key: ${swString(column.column.name)})`, `var ${column.prop}: ${column.sw}`]

export function modelFile(context: Context, info: TableInfo): GeneratedFile {
  const { table } = info
  const key = mappedKey(info)
  const others = info.columns.filter((column) => !key.includes(column))
  const checks = table.checks.map((check) => `/// CHECK (${check.sql}): the services check what they understand of it.`)
  let id: string[]
  if (key.length === 1) {
    const column = key[0]
    const by = column.column.generated === 'identity' && table.primaryKey?.length === 1 ? '.database' : '.user'
    id = [`@ID(custom: ${swString(column.column.name)}, generatedBy: ${by})`, `var id: ${column.sw}?`]
  } else
    id = [
      '/// The key, a value of each of its columns.',
      'final class IDValue: Fields, Hashable, @unchecked Sendable {',
      ...key.flatMap((column) => [...field({ ...column, column: { ...column.column, nullable: false } }).map((line) => `    ${line}`), '']),
      '    init() {}',
      '',
      '    static func == (lhs: IDValue, rhs: IDValue) -> Bool {',
      `        ${key.map((column) => `lhs.${column.prop} == rhs.${column.prop}`).join(' && ')}`,
      '    }',
      '',
      '    func hash(into hasher: inout Hasher) {',
      ...key.map((column) => `        hasher.combine(${column.prop})`),
      '    }',
      '}',
      '',
      '@CompositeID()',
      'var id: IDValue?',
    ]
  return swFile(fileOf(context, info, 'model', info.model), imports('FluentKit', 'Foundation'), [
    `/// The "${table.name}" table, as the database has it. Fluent never creates or changes it: the database already exists.`,
    ...(checks.length > 0 ? ['///', ...checks] : []),
    ...(table.primaryKey
      ? []
      : ['///', `/// It has no primary key: the model keys its rows by ${key.map((column) => column.key).join(', ')}.`]),
    `final class ${info.model}: Model, @unchecked Sendable {`,
    `    static let schema = ${swString(table.name)}`,
    ...(table.schema ? [`    static let space: String? = ${swString(table.schema)}`] : []),
    '',
    ...id.map((line) => (line === '' ? '' : `    ${line}`)),
    ...others.flatMap((column) => ['', ...field(column).map((line) => `    ${line}`)]),
    '',
    '    init() {}',
    '}',
  ])
}
