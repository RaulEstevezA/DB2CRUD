/**
 * What services take and return besides the entities: the DTOs of each table when services take DTOs (create,
 * update and read, as records or classes), and the changes of an update in every case, written as the settings
 * say: a Patch<T> per field, an Optional<T> per field (null when not sent), or every field. They carry no
 * validation: the service checks the values against the database's rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines } from '../types.ts'
import { capitalized, javaPath, JavaImports } from './java.ts'
import { commonPackage, packageOf, type ColumnInfo, type Context, type TableInfo } from './context.ts'

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

/** How a field of a DTO is read: `name()` of a record, `getName()` of a class. */
export function accessor(context: Context, field: string, record = context.settings.dtoKind !== 'class'): string {
  return record ? `${field}()` : `get${capitalized(field)}()`
}

/** The type of an update field. */
export function updateFieldType(context: Context, column: ColumnInfo): string {
  if (context.settings.updates === 'patch') return `Patch<${column.java}>`
  if (context.settings.updates === 'optional') return `Optional<${column.java}>`
  return column.java
}

/** A record, or a class with a constructor and getters. */
function type(name: string, doc: string, fields: { type: string; name: string }[], record: boolean): string[] {
  if (record)
    return [
      `/** ${doc} */`,
      fields.length === 0 ? `public record ${name}() {}` : `public record ${name}(`,
      ...(fields.length === 0
        ? []
        : [...fields.map((field, index) => `        ${field.type} ${field.name}${index < fields.length - 1 ? ',' : ''}`), ') {}']),
    ]
  return [
    `/** ${doc} */`,
    `public class ${name} {`,
    ...fields.map((field) => `    private final ${field.type} ${field.name};`),
    '',
    `    public ${name}(${fields.map((field) => `${field.type} ${field.name}`).join(', ')}) {`,
    ...fields.map((field) => `        this.${field.name} = ${field.name};`),
    '    }',
    ...fields.flatMap((field) => [
      '',
      `    public ${field.type} get${capitalized(field.name)}() {`,
      `        return ${field.name};`,
      '    }',
    ]),
    '}',
  ]
}

function unit(pkg: string, name: string, imports: JavaImports, body: string[]): GeneratedFile {
  const written = imports.write()
  return { path: javaPath(pkg, name), content: lines(`package ${pkg};`, '', written !== '' && [written, ''], ...body, '') }
}

function importsOf(context: Context, pkg: string, columns: ColumnInfo[], update: boolean): JavaImports {
  const imports = new JavaImports(pkg)
  for (const column of columns) if (column.javaImport) imports.add(column.javaImport)
  if (update && context.settings.updates === 'patch') imports.add(`${commonPackage(context)}.Patch`)
  if (update && context.settings.updates === 'optional') imports.add('java.util.Optional')
  return imports
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
  const record = context.settings.dtoKind !== 'class'
  const fieldsOf = (columns: ColumnInfo[]) => columns.map((column) => ({ type: column.java, name: column.prop }))
  const updateFields = updateColumns(info).map((column) => ({ type: updateFieldType(context, column), name: column.prop }))
  const update = info.role === 'entity'
  if (dtos) {
    const pkg = packageOf(context, info, 'dtos')
    if (update)
      files.push(
        unit(
          pkg,
          createDto(info),
          importsOf(context, pkg, createColumns(info), false),
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
        pkg,
        readDto(info),
        importsOf(context, pkg, readColumns(info), false),
        type(readDto(info), `A ${info.entity} as services return it.`, fieldsOf(readColumns(info)), record),
      ),
    )
  }
  if (update && info.service) {
    const pkg = updatePackage(context, info)
    files.push(
      unit(
        pkg,
        updateType(context, info),
        importsOf(context, pkg, updateColumns(info), true),
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
