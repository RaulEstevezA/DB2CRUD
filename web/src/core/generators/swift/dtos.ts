/**
 * What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
 * and read), and the changes of an update in every case, written as the settings say: a Patch per field, a double
 * optional per field (nil when not sent, .some(nil) to empty it), or every field. They carry no validation: the service
 * checks the values against the database's rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { fileOf, storedType, swFile, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { imports } from './swift.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const readDto = (info: TableInfo) => `${info.entity}Read`
/** The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities. */
export const updateType = (context: Context, info: TableInfo) =>
  context.settings.serviceTypes === 'dtos' ? `${info.entity}Update` : `${info.entity}Changes`

export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

/** The type of a field of the update: `Patch<String?>`, `String??` or the stored type. */
export function updateFieldType(context: Context, column: ColumnInfo): string {
  if (context.settings.updates === 'patch') return `Patch<${column.sw}?>`
  if (context.settings.updates === 'optional') return `${column.sw}??`
  return storedType(column)
}

interface Field {
  name: string
  type: string
  initial?: string
}

/** A struct with public properties and a public initializer that takes them. */
function struct(name: string, doc: string, conformances: string, fields: Field[]): string[] {
  return [
    `/// ${doc}`,
    `public struct ${name}: ${conformances} {`,
    ...fields.map((field) => `    public var ${field.name}: ${field.type}`),
    ...(fields.length > 0 ? [''] : []),
    `    public init(${fields.map((field) => `${field.name}: ${field.type}${field.initial ? ` = ${field.initial}` : ''}`).join(', ')}) {`,
    ...fields.map((field) => `        self.${field.name} = ${field.name}`),
    '    }',
    '}',
  ]
}

const UPDATE_DOC = {
  patch: 'fields left .absent keep their value; .set(nil) empties one.',
  optional: 'fields left nil keep their value; .some(nil) empties one.',
  full: 'every field is replaced.',
  partial: '',
}

/** The struct of the changes of an update. */
export function updateStruct(context: Context, info: TableInfo): string[] {
  const mode = context.settings.updates
  const initial = mode === 'patch' ? '.absent' : mode === 'optional' ? 'nil' : undefined
  return struct(
    updateType(context, info),
    `The values of a ${info.entity} that change: ${UPDATE_DOC[mode]}`,
    'Sendable',
    updateColumns(info).map((column) => ({ name: column.prop, type: updateFieldType(context, column), initial })),
  )
}

/** The changes of an update, in a file of their own: a DTO, or next to the service. */
export function updateFile(context: Context, info: TableInfo): GeneratedFile {
  const kind = context.settings.serviceTypes === 'dtos' ? 'dtos' : 'service'
  return swFile(fileOf(context, info, kind, updateType(context, info)), imports('Foundation'), updateStruct(context, info))
}

export function dtoFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const files: GeneratedFile[] = []
  if (info.role === 'entity')
    files.push(
      swFile(
        fileOf(context, info, 'dtos', createDto(info)),
        imports('Foundation'),
        struct(
          createDto(info),
          `The values of a new ${info.entity}. Fields left nil take the database's default; the service says which ones are required.`,
          'Sendable, Equatable',
          createColumns(info).map((column) => ({ name: column.prop, type: `${column.sw}?`, initial: 'nil' })),
        ),
      ),
    )
  files.push(
    swFile(
      fileOf(context, info, 'dtos', readDto(info)),
      imports('Foundation'),
      struct(
        readDto(info),
        `A ${info.entity} as services return it.`,
        'Sendable, Equatable',
        readColumns(info).map((column) => ({ name: column.prop, type: storedType(column) })),
      ),
    ),
  )
  return files
}
