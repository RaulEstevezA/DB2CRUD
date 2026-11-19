/**
 * The entity of each table (a plain struct with a field per column, every one of them `None` until it is set) and
 * its SeaORM module, which describes the table as the database has it: exact table and column names, types with their
 * lengths and precision, the key, unique values, foreign keys with their actions, defaults and the values the database
 * fills. SeaORM reads and writes rows through that module; the repositories turn its models into entities and back.
 * CHECK constraints are named in the module's documentation: the services check them.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { DbColumn, DbEnum } from '../../schema/types.ts'
import { columnOf, fileOf, findInfo, moduleOf, rsFile, storedType, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { rsString } from './rust.ts'

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const module = moduleOf(context, info, 'entity')
  const comment = info.table.comment ? `: ${info.table.comment}` : ''
  return rsFile(fileOf(module), '', [
    `/// A row of the "${info.name}" table${comment}. A field stays \`None\` until it is set or read.`,
    '#[derive(Debug, Clone, Default, PartialEq)]',
    `pub struct ${info.entity} {`,
    ...info.columns.map((column) => `    pub ${column.field}: Option<${column.rs}>,`),
    '}',
  ])
}

/** The enum of the database a column holds, when the database keeps it as a type of its own. */
export function nativeEnum(context: Context, column: DbColumn): DbEnum | undefined {
  const type = column.type
  if (type.kind !== 'enum' || context.settings.database === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

const quoteSql = (text: string) => `'${text.replace(/'/g, "''")}'`

/** The `column_type` of a column, when its Rust type alone does not say it. */
function columnType(context: Context, column: ColumnInfo): string | null {
  const type = column.column.type
  const enumType = nativeEnum(context, column.column)
  if (enumType) {
    // The entity keeps its text; the column is the enum, so the tests create it as the database has it
    const sql = context.settings.database === 'postgresql' ? `"${enumType.name}"` : `ENUM(${enumType.values.map(quoteSql).join(', ')})`
    return `custom(${rsString(sql)})`
  }
  switch (type.kind) {
    case 'text':
      if (type.length === undefined) return 'Text'
      return type.fixed ? `Char(Some(${type.length}))` : `String(StringLen::N(${type.length}))`
    case 'decimal':
      return `Decimal(Some((${type.precision ?? 10}, ${type.scale ?? 0})))`
    case 'binary':
      return type.length !== undefined ? `Binary(${type.length})` : null
    case 'enum': {
      // An enum kept with a CHECK: its text, as long as its longest value
      const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
      return `String(StringLen::N(${Math.max(1, ...values.map((value) => value.length))}))`
    }
    case 'json':
    case 'array':
    case 'unknown':
      return 'Text'
    default:
      return null
  }
}

/** The SeaORM attributes of a column, and the TODOs it needs. */
function attributes(context: Context, info: TableInfo, column: ColumnInfo, keyColumns: ColumnInfo[]): { attrs: string[]; todo: string[] } {
  const db = column.column
  const attrs: string[] = []
  const todo: string[] = []
  if (keyColumns.includes(column)) {
    attrs.push('primary_key')
    const single = info.table.primaryKey?.length === 1 && db.generated === 'identity'
    if (!single) attrs.push('auto_increment = false')
  }
  if (column.field.replace(/^r#/, '') !== db.name) attrs.push(`column_name = ${rsString(db.name)}`)
  const type = columnType(context, column)
  if (type) attrs.push(`column_type = ${rsString(type)}`)
  const enumType = nativeEnum(context, db)
  if (enumType && context.settings.database === 'postgresql') {
    // PostgreSQL takes and gives a value of the enum, not a text
    attrs.push('select_as = "text"', `save_as = ${rsString(`"${enumType.name}"`)}`)
  }
  if (db.nullable) attrs.push('nullable')
  const uniques = info.table.uniques.filter((unique) => unique.columns.includes(db.name))
  for (const unique of uniques) {
    if (unique.columns.length === 1) attrs.push('unique')
    else attrs.push(`unique_key = ${rsString(unique.name ?? unique.columns.join('_'))}`)
  }
  if (info.table.indexes.some((index) => index.columns.length === 1 && index.columns[0] === db.name)) attrs.push('indexed')
  if (db.generated === 'identity' && !(info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name))
    todo.push('// TODO: the database numbers this column; SeaORM numbers only a key of one column')
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    attrs.push(
      `default_expr = ${rsString(type === null && db.type.kind === 'date' ? 'Expr::current_date()' : 'Expr::current_timestamp()')}`,
    )
    if (db.generated === 'onUpdateNow') todo.push('// TODO: the database sets it again on every change; SeaORM only reads it')
  } else if (typeof db.generated === 'object') {
    attrs.push(`extra = ${rsString(`GENERATED ALWAYS AS (${db.generated.computed}) STORED`)}`)
  } else if (db.default?.kind === 'literal' && db.default.value !== null) {
    const value = db.default.value
    attrs.push(`default_value = ${typeof value === 'string' ? rsString(value) : String(value)}`)
  } else if (db.default?.kind === 'expression') {
    attrs.push(`default_expr = ${rsString(`Expr::cust(${rsString(db.default.sql)})`)}`)
    todo.push(`// TODO: the database fills it with ${db.default.sql} on insert; the repository never sends a value for it`)
  }
  if (db.comment && context.settings.database !== 'sqlite') attrs.push(`comment = ${rsString(db.comment)}`)
  return { attrs, todo }
}

/** Columns a database can index whole: not text or bytes without a length (MySQL cannot key those). */
const indexable = (column: ColumnInfo) => {
  const type = column.column.type
  if (type.kind === 'text' || type.kind === 'binary') return type.length !== undefined
  return !['json', 'array', 'unknown'].includes(type.kind)
}

/**
 * The columns SeaORM keys a table by: its primary key, or, when it has none, the columns that cannot be null and can be
 * indexed (or, failing those, every column that cannot be null).
 */
export function mappedKey(info: TableInfo): ColumnInfo[] {
  if (info.table.primaryKey) return info.key
  const set = info.columns.filter((column) => !column.column.nullable)
  const keyable = set.filter(indexable)
  if (keyable.length > 0) return keyable
  return set.length > 0 ? set : info.columns
}

const ACTIONS: Record<string, string> = {
  cascade: 'Cascade',
  'set null': 'SetNull',
  'set default': 'SetDefault',
  restrict: 'Restrict',
  'no action': 'NoAction',
}

export function tableFile(context: Context, info: TableInfo): GeneratedFile {
  const module = moduleOf(context, info, 'table')
  const { table } = info
  const keyColumns = mappedKey(info)
  const fields = info.columns.flatMap((column) => {
    const { attrs, todo } = attributes(context, info, column, keyColumns)
    return [...todo, ...(attrs.length > 0 ? [`#[sea_orm(${attrs.join(', ')})]`] : []), `pub ${column.field}: ${storedType(column)},`]
  })
  const relations: string[] = []
  const notes: string[] = []
  const variants = new Set<string>()
  for (const key of table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent) {
      notes.push(`// TODO: ${key.columns.join(', ')} points to ${key.references.table}, a table this project does not have`)
      continue
    }
    if (parent !== info && parent.writesEntity !== info.writesEntity) continue
    const columns = (names: string[], of: TableInfo, prefix: string) => {
      const items = names.map((name) => `${prefix}Column::${columnOf(of, name).variant}`)
      return items.length === 1 ? items[0] : `(${items.join(', ')})`
    }
    const parentModule = parent === info ? '' : `${moduleOf(context, parent, 'table')}::`
    let variant = key.columns.map((name) => columnOf(info, name).variant).join('')
    while (variants.has(variant)) variant += 'Key'
    variants.add(variant)
    const args = [
      `belongs_to = ${rsString(`${parentModule}Entity`)}`,
      `from = ${rsString(columns(key.columns, info, ''))}`,
      `to = ${rsString(columns(key.references.columns, parent, parentModule))}`,
      ...(key.onDelete ? [`on_delete = ${rsString(ACTIONS[key.onDelete])}`] : []),
    ]
    relations.push(`    #[sea_orm(${args.join(', ')})]`, `    ${variant},`)
  }
  const multiIndexes = table.indexes.filter((index) => index.columns.length > 1)
  for (const index of multiIndexes)
    notes.push(
      `// TODO: the index ${index.name ?? ''} on ${index.columns.join(', ')} is not described: SeaORM describes indexes of one column`.replace(
        '  ',
        ' ',
      ),
    )
  const checks = table.checks.map((check) => `CHECK (${check.sql}): the services check what they understand of it.`)
  return rsFile(
    fileOf(module),
    'use sea_orm::entity::prelude::*;',
    [
      ...notes,
      ...(notes.length > 0 ? [''] : []),
      '#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]',
      `#[sea_orm(${table.schema ? `schema_name = ${rsString(table.schema)}, ` : ''}table_name = ${rsString(table.name)})]`,
      'pub struct Model {',
      ...fields.map((line) => `    ${line}`),
      '}',
      '',
      '#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]',
      relations.length > 0 ? 'pub enum Relation {' : 'pub enum Relation {}',
      ...(relations.length > 0 ? [...relations, '}'] : []),
      '',
      'impl ActiveModelBehavior for ActiveModel {}',
    ],
    [
      `The "${table.name}" table, as the database has it. SeaORM never creates or changes it: the database already exists.`,
      ...(checks.length > 0 ? ['', ...checks] : []),
      ...(table.primaryKey
        ? []
        : ['', `It has no primary key: SeaORM keys its rows by ${keyColumns.map((column) => column.key).join(', ')}.`]),
    ],
  )
}

/** A literal of a default, as a Rust expression of the column's type. */
export function rsLiteral(column: ColumnInfo, value: string | number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  const text = String(value)
  switch (column.rs) {
    case 'i64':
    case 'i32':
    case 'i16':
      return text
    case 'f64':
    case 'f32':
      return /[.eE]/.test(text) ? text : `${text}.0`
    case 'bool':
      return text
    case 'String':
      return `${rsString(text)}.to_string()`
    case 'Vec<u8>':
      return `${rsString(text)}.as_bytes().to_vec()`
    default:
      return `${rsString(text)}.parse::<${column.rs}>().expect(${rsString(`a ${column.rs}`)})`
  }
}

/** The current time, as a value of the column's type. */
export function nowOf(column: ColumnInfo): string | null {
  switch (column.rs) {
    case 'chrono::DateTime<chrono::FixedOffset>':
      return 'chrono::Utc::now().fixed_offset()'
    case 'chrono::NaiveDateTime':
      return 'chrono::Utc::now().naive_utc()'
    case 'chrono::NaiveDate':
      return 'chrono::Utc::now().date_naive()'
    case 'chrono::NaiveTime':
      return 'chrono::Utc::now().time()'
    default:
      return null
  }
}
