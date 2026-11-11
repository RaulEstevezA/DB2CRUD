/**
 * `src/data-source.ts` (the TypeORM data source for the database DATABASE_URL names) and the entity of each
 * table: exact table and column names, the column types of the chosen database and every constraint of the
 * input, so the entities reflect the database instead of designing it. No migrations are written: the
 * database already exists.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbForeignKey, DbType, Dialect } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { memberName, quote, tsLiteral, TsImports } from '../typescript.ts'
import { columnOf, findInfo, moduleOf, pathOf, writesEntities, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mysql://app:app@localhost:3306/app',
  sqlite: 'sqlite:./app.db',
}

export const defaultUrl = (context: Context) => URLS[context.settings.database] ?? URLS.postgresql

export function dataSourceFile(context: Context): GeneratedFile {
  const imports = new TsImports('src/data-source').only('reflect-metadata').from('typeorm', 'DataSource')
  for (const info of context.tables) imports.from(moduleOf(context, info, 'entity'), info.entity)
  const content = lines(
    '/** The TypeORM data source: the database DATABASE_URL names (see .env.example), and every entity. */',
    imports.write(),
    '',
    `export const DATABASE_URL = process.env.DATABASE_URL ?? ${quote(defaultUrl(context))}`,
    '',
    '/** Every entity, so the data source knows every table */',
    `export const ENTITIES = [${context.tables.map((info) => info.entity).join(', ')}]`,
    '',
    '/**',
    ' * A data source for the database at `url`: postgresql://, mysql:// (also MariaDB) or sqlite:<file> (sqlite::memory:',
    ' * for one in memory). Call initialize() before using it. Whole numbers come back as numbers, and dates in UTC.',
    ' */',
    'export function createDataSource(url: string = DATABASE_URL): DataSource {',
    "  const scheme = url.slice(0, url.indexOf(':'))",
    "  if (scheme === 'sqlite') {",
    "    const file = url.slice('sqlite:'.length).replace(/^\\/\\//, '')",
    "    return new DataSource({ type: 'better-sqlite3', database: file || ':memory:', entities: ENTITIES })",
    '  }',
    "  if (scheme === 'postgresql' || scheme === 'postgres') return new DataSource({ type: 'postgres', url, entities: ENTITIES, parseInt8: true })",
    "  if (scheme === 'mysql' || scheme === 'mariadb')",
    '    return new DataSource({',
    "      type: 'mysql',",
    "      url: url.replace(/^mariadb:/, 'mysql:'),",
    '      entities: ENTITIES,',
    '      supportBigNumbers: true,',
    '      bigNumberStrings: false,',
    "      timezone: 'Z',",
    '    })',
    '  throw new Error(`DATABASE_URL names a database this project does not know: ${scheme}`)',
    '}',
    '',
  )
  return { path: 'src/data-source.ts', content }
}

/** `src/column-types.ts`, when a column needs it: exact decimals stay text. */
export function columnTypesFile(context: Context): GeneratedFile | null {
  const decimals = context.tables.some((info) => info.writesEntity && info.columns.some((column) => column.column.type.kind === 'decimal'))
  if (!decimals) return null
  return {
    path: 'src/column-types.ts',
    content: lines(
      '/** How some values are read from the database. */',
      "import type { ValueTransformer } from 'typeorm'",
      '',
      '/** Exact decimals stay text: drivers return them as text (or as numbers, SQLite), and nothing is rounded. */',
      'export const decimalText: ValueTransformer = {',
      '  to: (value: unknown) => value,',
      '  from: (value: unknown) => (value === null || value === undefined ? value : String(value)),',
      '}',
      '',
    ),
  }
}

// Entities

/** The column type TypeORM writes for the chosen database. */
function ormType(type: DbType, database: Dialect): string {
  const sqlite = database === 'sqlite'
  const postgres = database === 'postgresql'
  switch (type.kind) {
    case 'integer':
      if (sqlite) return 'integer'
      return type.bits === 16 ? 'smallint' : type.bits === 64 ? 'bigint' : postgres ? 'integer' : 'int'
    case 'decimal':
      return postgres ? 'numeric' : 'decimal'
    case 'float':
      if (sqlite) return 'real'
      return type.bits === 32 ? (postgres ? 'real' : 'float') : postgres ? 'double precision' : 'double'
    case 'text':
      return type.length === undefined ? 'text' : type.fixed ? 'char' : 'varchar'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'time':
      return 'time'
    case 'datetime':
      return postgres ? (type.timezone ? 'timestamptz' : 'timestamp') : 'datetime'
    case 'uuid':
      return sqlite ? 'varchar' : 'uuid'
    case 'binary':
      return postgres ? 'bytea' : sqlite ? 'blob' : type.length !== undefined ? 'varbinary' : 'blob'
    case 'json':
    case 'array':
      // Arrays are portable as JSON; a native PostgreSQL array is a decision for the user
      return sqlite ? 'simple-json' : 'json'
    case 'enum':
      return sqlite ? 'simple-enum' : 'enum'
    case 'unknown':
      return 'text'
  }
}

function columnOptions(context: Context, column: ColumnInfo, imports: TsImports, primary: boolean): string[] {
  const db = column.column
  const type = db.type
  const database = context.settings.database
  const options: string[] = []
  if (column.prop !== db.name) options.push(`name: ${quote(db.name)}`)
  options.push(`type: ${quote(ormType(type, database))}`)
  if (type.kind === 'text' && type.length !== undefined) options.push(`length: ${type.length}`)
  if (type.kind === 'uuid' && database === 'sqlite') options.push('length: 36')
  if (type.kind === 'binary' && type.length !== undefined && database !== 'postgresql' && database !== 'sqlite')
    options.push(`length: ${type.length}`)
  if (type.kind === 'decimal') {
    if (type.precision !== undefined) options.push(`precision: ${type.precision}`, `scale: ${type.scale ?? 0}`)
    imports.from('src/column-types', 'decimalText')
    options.push('transformer: decimalText')
  }
  if (type.kind === 'enum') {
    const values = context.schema.enums.find((item) => item.name === type.name)?.values ?? []
    options.push(`enum: [${values.map((value) => quote(value)).join(', ')}]`)
    if (database === 'postgresql') options.push(`enumName: ${quote(type.name)}`)
  }
  if (!primary && db.nullable) options.push('nullable: true')
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    options.push("default: () => 'CURRENT_TIMESTAMP'")
    if (db.generated === 'onUpdateNow' && database !== 'postgresql' && database !== 'sqlite') options.push("onUpdate: 'CURRENT_TIMESTAMP'")
  }
  if (typeof db.generated === 'object')
    options.push("generatedType: 'STORED'", `asExpression: ${quote(db.generated.computed)}`, 'insert: false', 'update: false')
  if (db.default?.kind === 'literal') options.push(`default: ${tsLiteral(db.default.value)}`)
  if (db.default?.kind === 'expression') options.push(`default: () => ${quote(db.default.sql)}`)
  if (db.comment) options.push(`comment: ${quote(db.comment)}`)
  return options
}

function columnLines(context: Context, info: TableInfo, column: ColumnInfo, imports: TsImports): Line[] {
  const db = column.column
  const primary = info.key.includes(column)
  const options = columnOptions(context, column, imports, primary)
  const decorators: string[] = []
  if (primary && db.generated === 'identity' && info.table.primaryKey) {
    imports.from('typeorm', 'PrimaryGeneratedColumn')
    decorators.push(`@PrimaryGeneratedColumn({ ${options.join(', ')} })`)
  } else if (primary && db.generated === 'uuid' && info.table.primaryKey) {
    imports.from('typeorm', 'PrimaryGeneratedColumn')
    decorators.push(`@PrimaryGeneratedColumn('uuid'${column.prop !== db.name ? `, { name: ${quote(db.name)} }` : ''})`)
  } else {
    const decorator = primary ? 'PrimaryColumn' : 'Column'
    imports.from('typeorm', decorator)
    decorators.push(`@${decorator}({ ${options.join(', ')} })`)
    if (!primary && (db.generated === 'identity' || db.generated === 'uuid')) {
      imports.from('typeorm', 'Generated')
      decorators.push(`@Generated(${db.generated === 'uuid' ? "'uuid'" : "'increment'"})`)
    }
  }
  const optional = db.nullable && !primary
  return [
    db.type.kind === 'unknown' && `  // TODO: "${db.type.sql}" has no TypeORM type here; it is mapped as text`,
    db.type.kind === 'array' &&
      `  // TODO: "${db.type.sql}" is mapped as JSON; use \`array: true\` on PostgreSQL if you need the native array`,
    ...decorators.map((decorator) => `  ${decorator}`),
    `  ${column.prop}!: ${optional ? `${column.ts} | null` : column.ts}`,
  ]
}

/** The property of the row a foreign key points to: `category` for `category_id`. */
function relationName(info: TableInfo, key: DbForeignKey): string {
  const base = key.columns.length === 1 ? memberName(key.columns[0].replace(/_id$/i, '')) : memberName(key.references.table)
  const taken = (name: string) => info.columns.some((column) => column.prop === name)
  return taken(base) ? `${base}Ref` : base
}

const ACTIONS: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET NULL',
  'set default': 'SET DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'NO ACTION',
}

/** A many-to-one relation for each foreign key, so the database gets the constraint; the key columns stay properties. */
function relationLines(context: Context, info: TableInfo, imports: TsImports): Line[] {
  const result: Line[] = []
  for (const key of info.table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent || !parent.table.primaryKey) continue
    imports.from('typeorm', 'ManyToOne', 'JoinColumn').type('typeorm', 'Relation')
    if (parent !== info) imports.from(moduleOf(context, parent, 'entity'), parent.entity)
    const options = [`nullable: ${key.columns.some((name) => columnOf(info, name).column.nullable) ? 'true' : 'false'}`]
    if (key.onDelete) options.push(`onDelete: '${ACTIONS[key.onDelete]}'`)
    if (key.onUpdate) options.push(`onUpdate: '${ACTIONS[key.onUpdate]}'`)
    const joins = key.columns.map(
      (name, position) =>
        `{ name: ${quote(name)}, referencedColumnName: ${quote(columnOf(parent, key.references.columns[position]).prop)}${key.name && key.columns.length === 1 ? `, foreignKeyConstraintName: ${quote(key.name)}` : ''} }`,
    )
    result.push(
      '',
      `  /** The ${parent.entity} this row points to (${key.columns.join(', ')}); loaded only when asked for */`,
      `  @ManyToOne(() => ${parent.entity}, { ${options.join(', ')} })`,
      `  @JoinColumn(${joins.length === 1 ? joins[0] : `[${joins.join(', ')}]`})`,
      `  ${relationName(info, key)}?: Relation<${parent.entity}>`,
    )
  }
  return result
}

function classDecorators(info: TableInfo, imports: TsImports): string[] {
  const { table } = info
  const props = (names: string[]) => `[${names.map((name) => quote(columnOf(info, name).prop)).join(', ')}]`
  const result: string[] = []
  const options = [`name: ${quote(table.name)}`]
  if (table.schema) options.push(`schema: ${quote(table.schema)}`)
  if (!table.primaryKey) options.push('synchronize: false')
  imports.from('typeorm', 'Entity')
  result.push(`@Entity({ ${options.join(', ')} })`)
  for (const unique of table.uniques) {
    imports.from('typeorm', 'Unique')
    result.push(unique.name ? `@Unique(${quote(unique.name)}, ${props(unique.columns)})` : `@Unique(${props(unique.columns)})`)
  }
  for (const index of table.indexes) {
    imports.from('typeorm', 'Index')
    result.push(index.name ? `@Index(${quote(index.name)}, ${props(index.columns)})` : `@Index(${props(index.columns)})`)
  }
  for (const check of table.checks) {
    imports.from('typeorm', 'Check')
    result.push(check.name ? `@Check(${quote(check.name)}, ${quote(check.sql)})` : `@Check(${quote(check.sql)})`)
  }
  return result
}

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const module = moduleOf(context, info, 'entity')
  const imports = new TsImports(module)
  const decorators = classDecorators(info, imports)
  const columns = info.columns.flatMap((column, index) => [index > 0 ? '' : null, ...columnLines(context, info, column, imports)])
  const relations = relationLines(context, info, imports)
  const content = lines(
    `/** Entity of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. */`,
    imports.write(),
    '',
    !info.table.primaryKey && [
      '// The table has no primary key: rows are told apart by all their columns, for reading only, and the',
      "// tests' data source does not create it (synchronize: false)",
    ],
    `/** A row of the "${info.name}" table. */`,
    ...decorators,
    `export class ${info.entity} {`,
    ...columns,
    ...relations,
    '}',
    '',
  )
  return { path: pathOf(module), content }
}

export function databaseFiles(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [dataSourceFile(context)]
  if (writesEntities(context)) files.push(columnTypesFile(context))
  for (const info of context.tables) if (info.writesEntity) files.push(entityFile(context, info))
  return files.filter((file): file is GeneratedFile => file !== null)
}
