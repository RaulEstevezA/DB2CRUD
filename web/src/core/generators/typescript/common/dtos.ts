/**
 * The DTOs of each table, when services take and return DTOs instead of entities: what a new row needs
 * (create), what may change (update, every field optional) and what is returned (read, without the hidden
 * columns). As interfaces or classes, as the settings say. They carry no validation of their own: the service
 * checks the values against the database's rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { columnType, moduleOf, pathOf, type ColumnInfo, type Context, type TableInfo } from './context.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const updateDto = (info: TableInfo) => `${info.entity}Update`
export const readDto = (info: TableInfo) => `${info.entity}Read`

export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

export function dtosFile(context: Context, info: TableInfo): GeneratedFile {
  const asClass = context.settings.dtoKind === 'class'
  const keyword = asClass ? 'export class' : 'export interface'
  const field = (column: ColumnInfo, optional: boolean) => `  ${column.prop}${optional ? '?' : asClass ? '!' : ''}: ${columnType(column)}`
  const block = (name: string, doc: string, fields: string[]) => [`/** ${doc} */`, `${keyword} ${name} {`, ...fields, '}']
  const content = lines(
    `/** What services take and return for the "${info.name}" table. */`,
    '',
    info.role === 'entity' && [
      ...block(
        createDto(info),
        `The values of a new ${info.entity}. Optional fields left out take the database's default.`,
        createColumns(info).map((column) => field(column, !column.required)),
      ),
      '',
      ...block(
        updateDto(info),
        `The values of a ${info.entity} that change; fields left out keep their value.`,
        updateColumns(info).map((column) => field(column, true)),
      ),
      '',
    ],
    ...block(
      readDto(info),
      `A ${info.entity} as services return it.`,
      readColumns(info).map((column) => field(column, false)),
    ),
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'dtos')), content }
}
