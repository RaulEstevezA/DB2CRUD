/**
 * What services take and return besides the entities: the DTOs of each table when services take DTOs (create,
 * update and read, as data classes or plain classes), and the changes of an update in every case, written as the
 * settings say: a Patch per field, an Optional per field (null when not sent), or every field. They carry no
 * validation: the service checks the values against the database's rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../export/files.ts'
import {
  commonPackage,
  ktFile,
  optionalType,
  packageOf,
  pathOf,
  qualified,
  storedType,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { KtImports } from './kotlin.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const readDto = (info: TableInfo) => `${info.entity}Read`
/** The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities. */
export const updateType = (context: Context, info: TableInfo) =>
  context.settings.serviceTypes === 'dtos' ? `${info.entity}Update` : `${info.entity}Changes`

export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

/** The package of the update type: the DTOs', or the service's. */
export const updatePackage = (context: Context, info: TableInfo) =>
  packageOf(context, info, context.settings.serviceTypes === 'dtos' ? 'dtos' : 'service')

export const updateClass = (context: Context, info: TableInfo) => qualified(updatePackage(context, info), updateType(context, info))

/** The type of a field of the update: `Patch<String?>`, `Optional<String>?` or the stored type. */
export function updateFieldType(context: Context, column: ColumnInfo): string {
  if (context.settings.updates === 'patch') return `Patch<${optionalType(column)}>`
  if (context.settings.updates === 'optional') return `Optional<${column.kt}>?`
  return storedType(column)
}

interface Field {
  type: string
  name: string
  initial?: string
}

/** A class whose fields are the parameters of its constructor. */
function dataClass(name: string, doc: string, fields: Field[], data: boolean): string[] {
  // A data class needs a field: without one (a table where nothing can change) it is a plain class
  if (fields.length === 0) return [`/** ${doc} */`, `class ${name}`]
  return [
    `/** ${doc} */`,
    `${data ? 'data ' : ''}class ${name}(`,
    ...fields.map((field) => `    val ${field.name}: ${field.type}${field.initial ? ` = ${field.initial}` : ''},`),
    ')',
  ]
}

const UPDATE_DOC = {
  patch: 'fields left absent keep their value; Patch.of(null) empties one.',
  optional: 'fields left null keep their value; Optional.empty() empties one.',
  full: 'every field is replaced.',
  partial: '',
}

export function dtoFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const dtos = context.settings.serviceTypes === 'dtos'
  const data = context.settings.dtoKind !== 'class'
  const imports = (pkg: string, columns: ColumnInfo[]) => {
    const result = new KtImports(pkg)
    for (const column of columns) if (column.ktImport) result.add(column.ktImport)
    return result
  }
  const update = info.role === 'entity'
  if (dtos) {
    const pkg = packageOf(context, info, 'dtos')
    if (update)
      files.push(
        ktFile(
          pathOf(pkg, createDto(info)),
          pkg,
          imports(pkg, createColumns(info)).write(),
          dataClass(
            createDto(info),
            `The values of a new ${info.entity}. Fields left null take the database's default; the service says which ones are required.`,
            createColumns(info).map((column) => ({ type: optionalType(column), name: column.prop, initial: 'null' })),
            data,
          ),
        ),
      )
    files.push(
      ktFile(
        pathOf(pkg, readDto(info)),
        pkg,
        imports(pkg, readColumns(info)).write(),
        dataClass(
          readDto(info),
          `A ${info.entity} as services return it.`,
          readColumns(info).map((column) => ({ type: storedType(column), name: column.prop })),
          data,
        ),
      ),
    )
  }
  if (update && info.service) {
    const pkg = updatePackage(context, info)
    const fieldImports = imports(pkg, updateColumns(info))
    const mode = context.settings.updates
    if (mode === 'patch') fieldImports.add(qualified(commonPackage(context), 'Patch'))
    if (mode === 'optional') fieldImports.add('java.util.Optional')
    const initial = mode === 'patch' ? 'Patch.absent()' : mode === 'optional' ? 'null' : undefined
    files.push(
      ktFile(
        pathOf(pkg, updateType(context, info)),
        pkg,
        fieldImports.write(),
        dataClass(
          updateType(context, info),
          `The values of a ${info.entity} that change: ${UPDATE_DOC[mode]}`,
          updateColumns(info).map((column) => ({ type: updateFieldType(context, column), name: column.prop, initial })),
          dtos ? data : true,
        ),
      ),
    )
  }
  return files
}
