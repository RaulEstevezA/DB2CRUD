/**
 * `src/models.ts`: a Mongoose model per collection that reflects the documents instead of designing them (the stored
 * name of every field, their types, what is required, values and limits, nested documents), defined on a connection
 * by `defineModels`. Mongoose never creates collections or indexes with them: the database already exists.
 */
import type { DbCheck, DbColumn, DbType } from '../../../schema/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { quote, tsLiteral } from '../typescript.ts'
import type { Context, TableInfo } from '../common/context.ts'

/** The module `defineModels` and `Models` are imported from: the project's, or the one the settings name. */
export function modelsModule(context: Context): string {
  return context.tables.some((info) => info.writesEntity) ? 'src/models' : context.settings.entitiesModule.replace(/\./g, '/')
}

export const fieldKey = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name))

/** The Mongoose type of a field. */
function schemaType(context: Context, type: DbType): string {
  switch (type.kind) {
    // JavaScript writes whole numbers as int: a validator may ask for another type
    case 'integer':
      return /^(long|BigInt)$/.test(type.sql) ? 'Schema.Types.BigInt' : 'Number'
    case 'float':
      return /^double$/i.test(type.sql) ? 'Schema.Types.Double' : 'Number'
    case 'decimal':
      return 'Schema.Types.Decimal128'
    case 'boolean':
      return 'Boolean'
    case 'datetime':
      return 'Date'
    case 'uuid':
      return 'Schema.Types.UUID'
    case 'binary':
      return 'Buffer'
    case 'array':
      return `[${schemaType(context, type.items)}]`
    case 'json':
      return type.fields ? nestedSchema(context, type.fields) : 'Schema.Types.Mixed'
    case 'text':
      return type.objectId ? 'Schema.Types.ObjectId' : 'String'
    case 'enum': {
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      return `{ type: String, enum: [${values.map((value) => quote(value)).join(', ')}] }`
    }
    // MongoDB has no dates without a time and no times of the day: their text
    case 'date':
    case 'time':
      return 'String'
    case 'unknown':
      return 'Schema.Types.Mixed'
  }
}

/** A schema inside another. The fields it does not name are kept when the document is written again. */
function nestedSchema(context: Context, fields: DbColumn[]): string {
  const own = fields.filter((field) => field.name !== '_id')
  const id = own.length < fields.length ? '' : '_id: false, '
  return `new Schema({ ${own.map((field) => `${fieldKey(field.name)}: ${definition(context, field, field.checks ?? [])}`).join(', ')} }, { ${id}strict: false, minimize: false })`
}

/** The settings of a field, besides its type. */
function settingsOf(column: DbColumn, checks: DbCheck[]): string[] {
  const settings: string[] = []
  // An empty list is a value: Mongoose gives one to every list left out
  if (column.type.kind === 'array') settings.push('default: undefined')
  if (!column.nullable && column.name !== '_id') settings.push('required: true')
  if (column.type.kind === 'text' && column.type.length !== undefined && !column.type.objectId)
    settings.push(`maxlength: ${column.type.length}`)
  for (const { parsed } of checks) {
    if (!parsed || parsed.column !== column.name) continue
    if (parsed.kind === 'in') settings.push(`enum: [${parsed.values.map((value) => tsLiteral(value)).join(', ')}]`)
    if (parsed.kind === 'compare' && parsed.op === '>=') settings.push(`min: ${parsed.value}`)
    if (parsed.kind === 'compare' && parsed.op === '<=') settings.push(`max: ${parsed.value}`)
    if (parsed.kind === 'length' && parsed.op === '>=') settings.push(`minlength: ${parsed.value}`)
  }
  if (column.generated === 'now' || column.generated === 'onUpdateNow') settings.push('default: () => new Date()')
  else if (column.generated === 'uuid' && column.type.kind === 'uuid') settings.push('default: () => randomUUID()')
  else if (column.default?.kind === 'literal' && column.default.value !== null) settings.push(`default: ${tsLiteral(column.default.value)}`)
  return settings
}

function definition(context: Context, column: DbColumn, checks: DbCheck[]): string {
  const type = schemaType(context, column.type)
  const settings = settingsOf(column, checks)
  if (column.type.kind === 'enum') return settings.length > 0 ? `${type.slice(0, -2)}, ${settings.join(', ')} }` : type
  return settings.length > 0 ? `{ type: ${type}, ${settings.join(', ')} }` : type
}

function schemaBlock(context: Context, info: TableInfo): Line[] {
  const { table } = info
  const fields = table.columns.filter((column) => column.name !== '_id' || column.generated !== 'uuid')
  const index = (columns: string[], options: string[]) =>
    `${info.attr}.index({ ${columns.map((column) => `${fieldKey(column)}: 1`).join(', ')} }${options.length > 0 ? `, { ${options.join(', ')} }` : ''})`
  return [
    '',
    `  /** The ${quote(table.name)} collection${table.comment ? `: ${table.comment}` : ''}. */`,
    `  const ${info.attr} = new Schema(`,
    '    {',
    ...fields.map((column) => `      ${fieldKey(column.name)}: ${definition(context, column, table.checks)},`),
    '    },',
    `    { collection: ${quote(table.name)}, versionKey: false, minimize: false, autoIndex: false, autoCreate: false },`,
    '  )',
    // For the tests' own database: in the application's, indexes are not touched
    ...table.uniques.map(
      (unique) => `  ${index(unique.columns, ['unique: true', ...(unique.name ? [`name: ${quote(unique.name)}`] : [])])}`,
    ),
    ...table.indexes.map((item) => `  ${index(item.columns, item.name ? [`name: ${quote(item.name)}`] : [])}`),
  ]
}

export function modelsFile(context: Context): GeneratedFile {
  const uuid = context.tables.some((info) => info.columns.some(({ column }) => column.generated === 'uuid' && column.type.kind === 'uuid'))
  const content = lines(
    '/** The collections of the database, as Mongoose models. They reflect it: Mongoose never creates collections or indexes with them. */',
    uuid && "import { randomUUID } from 'node:crypto'",
    "import { Schema, type Connection, type Model } from 'mongoose'",
    '',
    '/** A document as the driver gives it, by the stored names of its fields */',
    'export type Stored = Record<string, unknown>',
    '',
    '/** The model of every collection */',
    'export interface Models {',
    ...context.tables.map((info) => `  ${info.attr}: Model<Stored>`),
    '}',
    '',
    '/** Defines the model of every collection on `connection`. */',
    'export function defineModels(connection: Connection): Models {',
    ...context.tables.flatMap((info) => schemaBlock(context, info)).slice(1),
    '',
    '  return {',
    ...context.tables.map(
      (info) => `    ${info.attr}: connection.model<Stored>(${quote(info.entity)}, ${info.attr} as unknown as Schema<Stored>),`,
    ),
    '  }',
    '}',
    '',
  )
  return { path: 'src/models.ts', content }
}
