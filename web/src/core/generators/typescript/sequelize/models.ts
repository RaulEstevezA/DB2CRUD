/**
 * `src/models.ts`: a Sequelize model per table that reflects the database instead of designing it (exact table
 * and column names, the column types of the chosen database, keys, unique values, indexes, foreign keys with their
 * actions and enums), defined on a Sequelize instance by `defineModels`. Sequelize never syncs them with the
 * database the application uses: it already exists; the tests create their own database from them.
 */
import type { DbColumn, DbType } from '../../../schema/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { quote, tsLiteral } from '../typescript.ts'
import { findInfo, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'

export type Dialect = 'postgresql' | 'mysql' | 'sqlite'

export function dialectOf(context: Context): Dialect {
  const database = context.settings.database
  return database === 'mysql' || database === 'mariadb' ? 'mysql' : database === 'sqlite' ? 'sqlite' : 'postgresql'
}

/** The module `defineModels` and `Models` are imported from: the project's, or the one the settings name. */
export function modelsModule(context: Context): string {
  return context.tables.some((info) => info.writesEntity) ? 'src/models' : context.settings.entitiesModule.replace(/\./g, '/')
}

/** The variable of a model inside defineModels: the table's property, unless the function already uses that name. */
const modelVar = (info: TableInfo) => (['sequelize', 'literal', 'DataTypes'].includes(info.attr) ? `${info.attr}Model` : info.attr)

/** The precision written in the column's SQL type: `timestamp(3)` → 3. */
const precisionOf = (type: DbType) => /\((\d+)\)/.exec(type.sql)?.[1]

/** The Sequelize data type of a column on the chosen database. */
function dataType(context: Context, type: DbType): string {
  const dialect = dialectOf(context)
  const postgres = dialect === 'postgresql'
  switch (type.kind) {
    case 'integer':
      return type.bits === 16 ? 'DataTypes.SMALLINT' : type.bits === 64 ? 'DataTypes.BIGINT' : 'DataTypes.INTEGER'
    case 'decimal':
      return type.precision !== undefined ? `DataTypes.DECIMAL(${type.precision}, ${type.scale ?? 0})` : 'DataTypes.DECIMAL'
    case 'float':
      return type.bits === 32 ? (postgres ? 'DataTypes.REAL' : 'DataTypes.FLOAT') : 'DataTypes.DOUBLE'
    case 'text':
      if (type.length === undefined) return 'DataTypes.TEXT'
      return `DataTypes.${type.fixed ? 'CHAR' : 'STRING'}(${type.length})`
    case 'boolean':
      return 'DataTypes.BOOLEAN'
    case 'date':
      return 'DataTypes.DATEONLY'
    case 'time':
      return 'DataTypes.TIME'
    case 'datetime': {
      const precision = precisionOf(type)
      return dialect === 'mysql' && precision ? `DataTypes.DATE(${precision})` : 'DataTypes.DATE'
    }
    case 'uuid':
      return 'DataTypes.UUID'
    case 'binary':
      return 'DataTypes.BLOB'
    case 'json':
    case 'array':
      return postgres && !/^json$/i.test(type.sql) ? 'DataTypes.JSONB' : 'DataTypes.JSON'
    case 'enum': {
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      return `DataTypes.ENUM(${values.map((value) => quote(value)).join(', ')})`
    }
    case 'unknown':
      return 'DataTypes.TEXT'
  }
}

const ACTIONS: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET NULL',
  'set default': 'SET DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'NO ACTION',
}

function defaultOf(column: DbColumn): string | null {
  if (column.generated === 'uuid') return 'DataTypes.UUIDV4'
  if (column.generated === 'now' || column.generated === 'onUpdateNow') return "literal('CURRENT_TIMESTAMP')"
  const value = column.default
  if (!value) return null
  if (value.kind === 'expression') return `literal(${quote(value.sql)})`
  return value.value === null ? null : tsLiteral(value.value)
}

function attributeLines(context: Context, info: TableInfo, column: ColumnInfo): Line[] {
  const db = column.column
  const options = [`type: ${dataType(context, db.type)}`]
  if (info.table.primaryKey?.includes(db.name)) options.push('primaryKey: true')
  if (db.generated === 'identity') options.push('autoIncrement: true')
  options.push(`allowNull: ${db.nullable ? 'true' : 'false'}`)
  const value = defaultOf(db)
  if (value) options.push(`defaultValue: ${value}`)
  if (column.prop !== db.name) options.push(`field: ${quote(db.name)}`)
  if (db.comment) options.push(`comment: ${quote(db.comment)}`)
  // A foreign key of one column; Sequelize keeps no foreign key of several
  const key = info.table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === db.name)
  const parent = key && findInfo(context, key.references.table)
  if (key && parent)
    options.push(
      `references: { model: ${quote(parent.name)}, key: ${quote(key.references.columns[0])} }`,
      `onDelete: '${ACTIONS[key.onDelete ?? 'no action']}'`,
      `onUpdate: '${ACTIONS[key.onUpdate ?? 'no action']}'`,
    )
  const composite = info.table.foreignKeys.find((item) => item.columns.length > 1 && item.columns[0] === db.name)
  return [
    typeof db.generated === 'object' &&
      `    // TODO: ${db.name} is computed by the database (${db.generated.computed}); Sequelize cannot say so, and the repositories never write it`,
    db.type.kind === 'unknown' && `    // TODO: "${db.type.sql}" has no Sequelize type here; it is mapped as text`,
    db.type.kind === 'array' &&
      `    // TODO: "${db.type.sql}" is mapped as JSON; use DataTypes.ARRAY on PostgreSQL if you need the native array`,
    composite &&
      `    // TODO: (${composite.columns.join(', ')}) points to ${composite.references.table}; Sequelize keeps no foreign key of several columns`,
    `    ${column.prop}: { ${options.join(', ')} },`,
  ]
}

function modelBlock(context: Context, info: TableInfo): (Line | Line[])[] {
  const { table } = info
  const names = (columns: string[]) => `[${columns.map((name) => quote(name)).join(', ')}]`
  const indexes = [
    ...table.uniques.map(
      (unique) => `{ ${unique.name ? `name: ${quote(unique.name)}, ` : ''}unique: true, fields: ${names(unique.columns)} }`,
    ),
    ...table.indexes.map((index) => `{ ${index.name ? `name: ${quote(index.name)}, ` : ''}fields: ${names(index.columns)} }`),
  ]
  const options = [
    `tableName: ${quote(table.name)}`,
    table.schema && `schema: ${quote(table.schema)}`,
    'timestamps: false',
    table.comment && `comment: ${quote(table.comment)}`,
  ].filter(Boolean)
  return [
    `  /** The "${table.name}" table. */`,
    ...table.checks.map((check) => `  // CHECK (${check.sql}): Sequelize does not keep CHECK constraints; the services check them`),
    `  const ${modelVar(info)} = sequelize.define(`,
    `    ${quote(table.name)},`,
    '    {',
    ...info.columns
      .flatMap((column) => attributeLines(context, info, column))
      .map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    '    },',
    indexes.length > 0
      ? [
          '    {',
          ...options.map((item) => `      ${item},`),
          '      indexes: [',
          ...indexes.map((item) => `        ${item},`),
          '      ],',
          '    },',
        ]
      : `    { ${options.join(', ')} },`,
    '  )',
    !table.primaryKey && [
      '  // The table has no primary key: Sequelize would add an id; rows are told apart by all their columns, for reading only',
      `  ${modelVar(info)}.removeAttribute('id')`,
    ],
  ]
}

export function modelsFile(context: Context): GeneratedFile {
  const literal = context.tables.some((info) =>
    info.columns.some(
      (column) =>
        column.column.generated === 'now' || column.column.generated === 'onUpdateNow' || column.column.default?.kind === 'expression',
    ),
  )
  const content = lines(
    '/** The tables of the database, as Sequelize models. They reflect the database: never sync them with it. */',
    `import { DataTypes, ${literal ? 'literal, ' : ''}type Model, type ModelStatic, type Sequelize } from 'sequelize'`,
    '',
    '/** The model of every table */',
    'export interface Models {',
    ...context.tables.map((info) => `  ${info.attr}: ModelStatic<Model>`),
    '}',
    '',
    '/** Defines the model of every table on `sequelize`. */',
    'export function defineModels(sequelize: Sequelize): Models {',
    ...context.tables.flatMap((info, index) => [index > 0 ? '' : null, ...modelBlock(context, info)]),
    `  return { ${context.tables.map((info) => (modelVar(info) === info.attr ? info.attr : `${info.attr}: ${modelVar(info)}`)).join(', ')} }`,
    '}',
    '',
  )
  return { path: 'src/models.ts', content }
}
