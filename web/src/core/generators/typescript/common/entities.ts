/**
 * Plain entities, for the ORMs that keep their tables outside classes (a Prisma schema): one class per table
 * with a property per column and the TypeScript types every TypeScript project uses (common/context.ts), so
 * services, DTOs and tests are the same whatever the ORM. The ORM's repositories turn its rows into them.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { columnType, moduleOf, pathOf, type Context, type TableInfo } from './context.ts'

export function plainEntityFile(context: Context, info: TableInfo, where: string): GeneratedFile {
  const module = moduleOf(context, info, 'entity')
  const primary = (column: TableInfo['columns'][number]) => info.key.includes(column) && info.table.primaryKey !== null
  const content = lines(
    `/** Entity of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. */`,
    '',
    `/** A row of the "${info.name}" table, as the repositories read and write it. ${where} */`,
    `export class ${info.entity} {`,
    ...info.columns.flatMap((column, index) => [
      index > 0 ? '' : null,
      column.column.comment ? `  /** ${column.column.comment} */` : null,
      `  ${column.prop}!: ${columnType(column, column.column.nullable && !primary(column))}`,
    ]),
    '}',
    '',
  )
  return { path: pathOf(module), content }
}
