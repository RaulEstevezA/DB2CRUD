/**
 * What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
 * and read, in one module), and the changes of an update in every case, written as the settings say: a Patch per
 * field, a double Option per field (None when not sent, Some(None) to empty it), or every field. They carry no
 * validation: the service checks the values against the database's rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { fileOf, moduleOf, pathIn, rsFile, storedType, type ColumnInfo, type Context, type TableInfo } from './context.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const readDto = (info: TableInfo) => `${info.entity}Read`
/** The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities. */
export const updateType = (context: Context, info: TableInfo) =>
  context.settings.serviceTypes === 'dtos' ? `${info.entity}Update` : `${info.entity}Changes`

export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

/** The path of the update type: in the DTOs' module, or in the service's. */
export const updatePath = (context: Context, info: TableInfo) =>
  pathIn(moduleOf(context, info, context.settings.serviceTypes === 'dtos' ? 'dtos' : 'service'), updateType(context, info))

/** The type of a field of the update: `Patch<Option<String>>`, `Option<Option<String>>` or the stored type. */
export function updateFieldType(context: Context, column: ColumnInfo): string {
  if (context.settings.updates === 'patch') return `crate::common::Patch<Option<${column.rs}>>`
  if (context.settings.updates === 'optional') return `Option<Option<${column.rs}>>`
  return storedType(column)
}

function struct(name: string, doc: string, derives: string, fields: { name: string; type: string }[]): string[] {
  return [
    `/// ${doc}`,
    `#[derive(${derives})]`,
    fields.length > 0 ? `pub struct ${name} {` : `pub struct ${name} {}`,
    ...fields.map((field) => `    pub ${field.name}: ${field.type},`),
    ...(fields.length > 0 ? ['}'] : []),
  ]
}

const UPDATE_DOC = {
  patch: 'fields left Absent keep their value; Patch::Set(None) empties one.',
  optional: 'fields left None keep their value; Some(None) empties one.',
  full: 'every field is replaced.',
  partial: '',
}

/** The struct of the changes of an update. */
export function updateStruct(context: Context, info: TableInfo): string[] {
  const mode = context.settings.updates
  return struct(
    updateType(context, info),
    `The values of a ${info.entity} that change: ${UPDATE_DOC[mode]}`,
    mode === 'full' ? 'Debug, Clone, PartialEq' : 'Debug, Clone, Default, PartialEq',
    updateColumns(info).map((column) => ({ name: column.field, type: updateFieldType(context, column) })),
  )
}

/** The DTOs of a table, in one module. */
export function dtoFile(context: Context, info: TableInfo): GeneratedFile {
  const update = info.role === 'entity'
  const body: string[] = []
  if (update)
    body.push(
      ...struct(
        createDto(info),
        `The values of a new ${info.entity}. Fields left None take the database's default; the service says which ones are required.`,
        'Debug, Clone, Default, PartialEq',
        createColumns(info).map((column) => ({ name: column.field, type: `Option<${column.rs}>` })),
      ),
      '',
    )
  body.push(
    ...struct(
      readDto(info),
      `A ${info.entity} as services return it.`,
      'Debug, Clone, PartialEq',
      readColumns(info).map((column) => ({ name: column.field, type: storedType(column) })),
    ),
  )
  if (update && info.service) body.push('', ...updateStruct(context, info))
  return rsFile(fileOf(moduleOf(context, info, 'dtos')), '', body, [`What the service of ${info.name} takes and returns.`])
}
