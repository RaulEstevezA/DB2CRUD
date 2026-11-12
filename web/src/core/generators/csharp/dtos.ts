/**
 * What services take and return besides the entities: the DTOs of each table when services take DTOs (create,
 * update and read, as records or classes), and the changes of an update in every case, written as the settings
 * say: a Patch<T> per field, or every field. They carry no validation: the service checks the values against the
 * database's rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines } from '../types.ts'
import { CsUsings } from './csharp.ts'
import { commonNamespace, namespaceOf, pathOf, type ColumnInfo, type Context, type TableInfo } from './context.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const readDto = (info: TableInfo) => `${info.entity}Read`
/** The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities. */
export const updateType = (context: Context, info: TableInfo) =>
  context.settings.serviceTypes === 'dtos' ? `${info.entity}Update` : `${info.entity}Changes`

export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

/** The namespace of the update type: the DTOs', or the service's. */
export const updateNamespace = (context: Context, info: TableInfo) =>
  namespaceOf(context, info, context.settings.serviceTypes === 'dtos' ? 'dtos' : 'service')

interface Field {
  type: string
  name: string
  /** A reference type that is never null: a class property needs `= null!` */
  required: boolean
}

/** A positional record, or a class with init-only properties. */
function type(name: string, doc: string, fields: Field[], record: boolean): string[] {
  if (record)
    return [
      `/// <summary>${doc}</summary>`,
      `public record ${name}(`,
      ...fields.map((field, index) => `    ${field.type} ${field.name}${index < fields.length - 1 ? ',' : ''}`),
      ');',
    ]
  return [
    `/// <summary>${doc}</summary>`,
    `public class ${name}`,
    '{',
    ...fields.map((field) => `    public ${field.type} ${field.name} { get; init; }${field.required ? ' = null!;' : ''}`),
    '}',
  ]
}

function unit(ns: string, name: string, usings: CsUsings, body: string[]): GeneratedFile {
  const written = usings.write()
  return { path: pathOf(ns, name), content: lines(written !== '' && [written, ''], `namespace ${ns};`, '', ...body, '') }
}

const UPDATE_DOC = {
  patch: 'fields left Patch.Absent keep their value; Patch.Of(null) empties one.',
  full: 'every field is replaced.',
  optional: '',
  partial: '',
}

export function dtoFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const dtos = context.settings.serviceTypes === 'dtos'
  const record = context.settings.dtoKind !== 'class'
  const fieldsOf = (columns: ColumnInfo[]): Field[] =>
    columns.map((column) => ({ type: column.propType, name: column.prop, required: !column.optional && !column.valueType }))
  const patch = context.settings.updates === 'patch'
  const updateFields = updateColumns(info).map((column) => ({
    type: patch ? `Patch<${column.propType}>` : column.propType,
    name: column.prop,
    required: patch || (!column.optional && !column.valueType),
  }))
  const update = info.role === 'entity'
  if (dtos) {
    const ns = namespaceOf(context, info, 'dtos')
    if (update)
      files.push(
        unit(
          ns,
          createDto(info),
          new CsUsings(ns),
          type(
            createDto(info),
            `The values of a new ${info.entity}. Fields left null take the database's default.`,
            fieldsOf(createColumns(info)),
            record,
          ),
        ),
      )
    files.push(
      unit(
        ns,
        readDto(info),
        new CsUsings(ns),
        type(readDto(info), `A ${info.entity} as services return it.`, fieldsOf(readColumns(info)), record),
      ),
    )
  }
  if (update && info.service) {
    const ns = updateNamespace(context, info)
    const usings = new CsUsings(ns)
    if (patch) usings.add(commonNamespace(context))
    files.push(
      unit(
        ns,
        updateType(context, info),
        usings,
        type(
          updateType(context, info),
          `The values of a ${info.entity} that change: ${UPDATE_DOC[context.settings.updates]}`,
          updateFields,
          dtos ? record : true,
        ),
      ),
    )
  }
  return files
}
