/**
 * What services take and return besides the entities: the DTOs of each table when services take DTOs (create,
 * update and read, as readonly or plain classes with promoted constructors), and the changes of an update in every
 * case, written as the settings say: a Patch per field, an array of the changed fields (no class), or every field.
 * They carry no validation: the service checks the values against the database's rules, so every caller gets the
 * same errors.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import {
  className,
  commonClass,
  namespaceOf,
  optionalType,
  pathOf,
  phpFile,
  storedType,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { PhpUses } from './php.ts'

export const createDto = (info: TableInfo) => `${info.entity}Create`
export const readDto = (info: TableInfo) => `${info.entity}Read`
/** The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities. */
export const updateType = (context: Context, info: TableInfo) =>
  context.settings.serviceTypes === 'dtos' ? `${info.entity}Update` : `${info.entity}Changes`
/** Whether the changes of an update are an array of the changed fields, with no class of their own. */
export const partialUpdates = (context: Context) => context.settings.updates === 'partial'

export const createColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated)
export const updateColumns = (info: TableInfo) => info.columns.filter((column) => !column.generated && !info.key.includes(column))
export const readColumns = (info: TableInfo) => info.columns.filter((column) => !info.hidden.includes(column.column.name))

/** The namespace of the update type: the DTOs', or the service's. */
export const updateNamespace = (context: Context, info: TableInfo) =>
  namespaceOf(context, info, context.settings.serviceTypes === 'dtos' ? 'dtos' : 'service')

/** The type of a stored value as PHPDoc writes it: `string|null`. */
export const docType = (column: ColumnInfo) => storedType(column).replace(/^\?(.*)$/, '$1|null')

/** The shape of the array an update takes when updates are partial: `array{email?: string, ...}`. */
export const partialShape = (info: TableInfo) =>
  `array{${updateColumns(info)
    .map((column) => `${column.field}?: ${docType(column)}`)
    .join(', ')}}`

interface Param {
  type: string
  name: string
  /** `= null`, `= new Patch()` */
  initial?: string
}

/** A class whose fields are the parameters of its constructor. */
function dataClass(name: string, doc: string[], params: Param[], readonly: boolean, paramsDoc: string[] = []): string[] {
  return [
    ...doc,
    `final ${readonly ? 'readonly ' : ''}class ${name}`,
    '{',
    ...(paramsDoc.length > 0 ? ['    /**', ...paramsDoc.map((line) => `     * ${line}`), '     */'] : []),
    '    public function __construct(',
    ...params.map((param) => `        public ${param.type} $${param.name}${param.initial ? ` = ${param.initial}` : ''},`),
    '    ) {',
    '    }',
    '}',
  ]
}

const UPDATE_DOC = {
  patch: 'fields left absent keep their value; Patch::of(null) empties one.',
  full: 'every field is replaced.',
  optional: '',
  partial: '',
}

export function dtoFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const dtos = context.settings.serviceTypes === 'dtos'
  const readonly = context.settings.dtoKind !== 'class'
  const unit = (ns: string, name: string, uses: PhpUses, body: string[]) => phpFile(pathOf(ns, name), ns, uses.write(), body)
  const update = info.role === 'entity'
  if (dtos) {
    const ns = namespaceOf(context, info, 'dtos')
    if (update)
      files.push(
        unit(
          ns,
          createDto(info),
          new PhpUses(ns),
          dataClass(
            createDto(info),
            [
              `/** The values of a new ${info.entity}. Fields left null take the database's default; the service says which ones are required. */`,
            ],
            createColumns(info).map((column: ColumnInfo) => ({ type: optionalType(column), name: column.field, initial: 'null' })),
            readonly,
          ),
        ),
      )
    files.push(
      unit(
        ns,
        readDto(info),
        new PhpUses(ns),
        dataClass(
          readDto(info),
          [`/** A ${info.entity} as services return it. */`],
          readColumns(info).map((column) => ({ type: storedType(column), name: column.field })),
          readonly,
        ),
      ),
    )
  }
  if (update && info.service && !partialUpdates(context)) {
    const ns = updateNamespace(context, info)
    const uses = new PhpUses(ns)
    const patch = context.settings.updates === 'patch'
    if (patch) uses.add(commonClass(context, 'Patch'))
    const params: Param[] = updateColumns(info).map((column) =>
      patch ? { type: 'Patch', name: column.field, initial: 'new Patch()' } : { type: storedType(column), name: column.field },
    )
    const doc = [`/** The values of a ${info.entity} that change: ${UPDATE_DOC[context.settings.updates]} */`]
    const paramsDoc = patch ? updateColumns(info).map((column) => `@param Patch<${docType(column)}> $${column.field}`) : []
    files.push(
      unit(ns, updateType(context, info), uses, dataClass(updateType(context, info), doc, params, dtos ? readonly : true, paramsDoc)),
    )
  }
  return files
}

/** The full name of the update type, for `use`. */
export const updateClass = (context: Context, info: TableInfo) => className(updateNamespace(context, info), updateType(context, info))
