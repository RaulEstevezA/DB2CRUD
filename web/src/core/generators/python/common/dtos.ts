/**
 * The DTOs of each table, when services take and return DTOs instead of entities: what a new row needs
 * (create), what may change (update, every field optional) and what is returned (read, without the hidden
 * columns). They carry no validation of their own: the service checks the values against the database's
 * rules, so every caller gets the same errors.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { Imports } from '../python.ts'
import { columnPyType, moduleOf, pathOf, type ColumnInfo, type Context, type TableInfo } from './context.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const updateDto = (info: TableInfo) => `${info.entity}Update`
export const readDto = (info: TableInfo) => `${info.entity}Read`

/** Columns a client sends when creating: everything the database does not fill. */
export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
/** Columns a client may change: not the key, not what the database fills. */
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
/** Columns returned: all but the hidden ones. */
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

export function dtosFile(context: Context, info: TableInfo): GeneratedFile {
  const imports = new Imports()
  const pydantic = context.settings.dtoKind === 'pydantic'
  if (pydantic) imports.from('pydantic', 'BaseModel')
  else imports.from('dataclasses', 'dataclass')
  const field = (column: ColumnInfo, optional: boolean) =>
    `    ${column.attr}: ${columnPyType(column, imports, optional || column.column.nullable)}${optional || column.column.nullable ? ' = None' : ''}`
  const header = (name: string, doc: string) =>
    pydantic
      ? [`class ${name}(BaseModel):`, `    """${doc}"""`, '']
      : ['@dataclass(kw_only=True)', `class ${name}:`, `    """${doc}"""`, '']
  const create = createColumns(info).map((column) => field(column, !column.required))
  const update = updateColumns(info).map((column) => field(column, true))
  const read = readColumns(info).map((column) => field(column, false))
  if (pydantic) imports.from('pydantic', 'ConfigDict')
  const content = lines(
    `"""What services take and return for the "${info.name}" table."""`,
    '',
    imports.write('app'),
    info.role === 'entity' && [
      '',
      '',
      ...header(createDto(info), `The values of a new ${info.entity}. Optional fields left out take the database's default.`),
      ...(create.length > 0 ? create : ['    pass']),
      '',
      '',
      ...header(updateDto(info), `The values of a ${info.entity} that change; fields left out keep their value.`),
      ...(update.length > 0 ? update : ['    pass']),
    ],
    '',
    '',
    ...header(readDto(info), `A ${info.entity} as services return it.`),
    pydantic && ['    model_config = ConfigDict(from_attributes=True)', ''],
    ...(read.length > 0 ? read : ['    pass']),
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'dtos')), content }
}
