/**
 * The JPA entity of each table: exact table and column names, the column types of the chosen database, keys
 * (an @IdClass record when there are several columns), unique constraints, indexes, CHECK constraints and foreign
 * keys (a read-only many-to-one beside the key columns, so the constraint exists), so the entities reflect the
 * database instead of designing it. Values the database fills (defaults, identities) are left to it
 * (@DynamicInsert) and read back by the repositories.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { DbEnum, Dialect } from '../../schema/types.ts'
import { lines, type Line } from '../types.ts'
import { javaPath, javaString, JavaImports } from './java.ts'
import { findInfo, jpqlName, packageOf, qualified, type ColumnInfo, type Context, type TableInfo } from './context.ts'

const PERSISTENCE = 'jakarta.persistence'
const HIBERNATE = 'org.hibernate.annotations'

const quoteSql = (text: string) => `'${text.replace(/'/g, "''")}'`

function nativeEnum(context: Context, column: ColumnInfo): DbEnum | undefined {
  const type = column.column.type
  if (type.kind !== 'enum' || context.settings.database === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

/** The SQL that creates the enum types of PostgreSQL the entities use, for the tests' database. */
export function enumTypes(context: Context): string[] {
  if (context.settings.database !== 'postgresql') return []
  const used = new Set(context.tables.flatMap((info) => info.columns.map((column) => nativeEnum(context, column)?.name)))
  return context.schema.enums
    .filter((item) => used.has(item.name))
    .map((item) => `CREATE TYPE "${item.name}" AS ENUM (${item.values.map(quoteSql).join(', ')})`)
}

function columnAnnotations(context: Context, info: TableInfo, column: ColumnInfo, imports: JavaImports): string[] {
  const db = column.column
  const type = db.type
  const database: Dialect = context.settings.database
  const single = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  const primary = info.key.includes(column)
  const result: string[] = []
  const options = [`name = ${javaString(db.name)}`]
  if (!db.nullable) options.push('nullable = false')
  if (type.kind === 'text' && type.length !== undefined) options.push(`length = ${type.length}`)
  if (type.kind === 'binary' && type.length !== undefined) options.push(`length = ${type.length}`)
  if (type.kind === 'decimal' && type.precision !== undefined) options.push(`precision = ${type.precision}`, `scale = ${type.scale ?? 0}`)
  if (type.kind === 'uuid' && database !== 'postgresql') options.push('length = 36')
  const enumType = nativeEnum(context, column)
  // MySQL keeps no long text in a key: the key of a table without one stays varchar in the tests' database
  const mysql = database === 'mysql' || database === 'mariadb'
  if (type.kind === 'text' && type.length === undefined && !(mysql && !info.table.primaryKey)) options.push('columnDefinition = "text"')
  if (enumType)
    options.push(
      `columnDefinition = ${javaString(database === 'postgresql' ? `"${enumType.name}"` : `enum(${enumType.values.map(quoteSql).join(', ')})`)}`,
    )
  if (typeof db.generated === 'object') options.push('insertable = false', 'updatable = false')
  if (primary) {
    imports.add(`${PERSISTENCE}.Id`)
    result.push('@Id')
  }
  if (single && db.generated === 'identity') {
    imports.add(`${PERSISTENCE}.GeneratedValue`, `${PERSISTENCE}.GenerationType`)
    result.push('@GeneratedValue(strategy = GenerationType.IDENTITY)')
  }
  if (single && db.generated === 'uuid') {
    imports.add(`${PERSISTENCE}.GeneratedValue`, `${PERSISTENCE}.GenerationType`)
    result.push('@GeneratedValue(strategy = GenerationType.UUID)')
  }
  imports.add(`${PERSISTENCE}.Column`)
  result.push(`@Column(${options.join(', ')})`)
  // SQLite counts up a key only when its type is INTEGER
  if (single && db.generated === 'identity' && database === 'sqlite') {
    imports.add(`${HIBERNATE}.JdbcTypeCode`, 'org.hibernate.type.SqlTypes')
    result.push('@JdbcTypeCode(SqlTypes.INTEGER)')
  }
  if (type.kind === 'text' && type.fixed) {
    imports.add(`${HIBERNATE}.JdbcTypeCode`, 'org.hibernate.type.SqlTypes')
    result.push('@JdbcTypeCode(SqlTypes.CHAR)')
  }
  if (type.kind === 'uuid' && database !== 'postgresql') {
    imports.add(`${HIBERNATE}.JdbcTypeCode`, 'org.hibernate.type.SqlTypes')
    result.push('@JdbcTypeCode(SqlTypes.CHAR)')
  }
  if (type.kind === 'json' || type.kind === 'array') {
    imports.add(`${HIBERNATE}.JdbcTypeCode`, 'org.hibernate.type.SqlTypes')
    result.push('@JdbcTypeCode(SqlTypes.JSON)')
  }
  // A uuid that is not the key is made by Hibernate before the insert: SQLite and MySQL have no default for it
  if (!single && db.generated === 'uuid') {
    imports.add(`${HIBERNATE}.UuidGenerator`)
    result.push('@UuidGenerator')
  }
  if (enumType && database === 'postgresql') {
    imports.add(`${HIBERNATE}.ColumnTransformer`)
    result.push(`@ColumnTransformer(write = ${javaString(`?::"${enumType.name}"`)})`)
  }
  // What the database fills, for the tests' database; the repositories read it back after an insert
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    imports.add(`${HIBERNATE}.ColumnDefault`)
    // MySQL's datetime(6) takes the current time with the same precision
    result.push(mysql ? '@ColumnDefault("CURRENT_TIMESTAMP(6)")' : '@ColumnDefault("CURRENT_TIMESTAMP")')
  } else if (db.generated === 'uuid' && !single && database === 'postgresql') {
    imports.add(`${HIBERNATE}.ColumnDefault`)
    result.push('@ColumnDefault("gen_random_uuid()")')
  } else if (typeof db.generated === 'object') {
    imports.add(`${HIBERNATE}.GeneratedColumn`)
    result.push(`@GeneratedColumn(${javaString(db.generated.computed)})`)
  } else if (db.default?.kind === 'literal' && db.default.value !== null) {
    imports.add(`${HIBERNATE}.ColumnDefault`)
    const value = db.default.value
    result.push(`@ColumnDefault(${javaString(typeof value === 'string' ? quoteSql(value) : String(value))})`)
  } else if (db.default?.kind === 'expression') {
    imports.add(`${HIBERNATE}.ColumnDefault`)
    result.push(`@ColumnDefault(${javaString(db.default.sql)})`)
  }
  if (db.comment) {
    imports.add(`${HIBERNATE}.Comment`)
    result.push(`@Comment(${javaString(db.comment)})`)
  }
  return result
}

const ACTIONS: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET_NULL',
  'set default': 'SET_DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'NO_ACTION',
}

/** The property of the row a foreign key points to: `category` for `category_id`. */
function relationName(info: TableInfo, columns: string[], parent: TableInfo): string {
  const base =
    columns.length === 1
      ? columns[0]
          .replace(/_id$/i, '')
          .replace(/_([a-z0-9])/gi, (_, char: string) => char.toUpperCase())
          .replace(/^./, (char) => char.toLowerCase())
      : parent.attr
  const taken = (name: string) => info.columns.some((column) => column.prop === name)
  return taken(base) ? `${base}Ref` : base
}

/** A read-only many-to-one per foreign key, so the database has the constraint; the key columns stay properties. */
function relationLines(context: Context, info: TableInfo, imports: JavaImports): Line[] {
  const result: Line[] = []
  for (const key of info.table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    if (!parent || !parent.table.primaryKey) continue
    const sameKey = parent.table.primaryKey.join(',') === key.references.columns.join(',')
    if (!sameKey) continue
    imports.add(`${PERSISTENCE}.ManyToOne`, `${PERSISTENCE}.FetchType`, `${PERSISTENCE}.JoinColumn`)
    if (packageOf(context, parent, 'entity') !== packageOf(context, info, 'entity'))
      imports.add(qualified(context, parent, 'entity', parent.entity))
    const foreignKey = key.name ? `, foreignKey = @ForeignKey(name = ${javaString(key.name)})` : ''
    if (key.name) imports.add(`${PERSISTENCE}.ForeignKey`)
    const join = (name: string, position: number) =>
      `@JoinColumn(name = ${javaString(name)}, referencedColumnName = ${javaString(key.references.columns[position])}, insertable = false, updatable = false${key.columns.length === 1 ? foreignKey : ''})`
    const joins =
      key.columns.length === 1
        ? [join(key.columns[0], 0)]
        : (imports.add(`${PERSISTENCE}.JoinColumns`), [`@JoinColumns(value = { ${key.columns.map(join).join(', ')} }${foreignKey})`])
    const action = key.onDelete && key.onDelete !== 'no action' ? ACTIONS[key.onDelete] : null
    if (action) imports.add(`${HIBERNATE}.OnDelete`, `${HIBERNATE}.OnDeleteAction`)
    result.push(
      '',
      `    /** The ${parent.entity} this row points to (${key.columns.join(', ')}); read only: the key columns are written. */`,
      '    @ManyToOne(fetch = FetchType.LAZY)',
      ...joins.map((item) => `    ${item}`),
      action && `    @OnDelete(action = OnDeleteAction.${action})`,
      `    private ${parent.entity} ${relationName(info, key.columns, parent)};`,
    )
  }
  return result
}

function classAnnotations(info: TableInfo, imports: JavaImports): string[] {
  const { table } = info
  imports.add(`${PERSISTENCE}.Entity`, `${PERSISTENCE}.Table`, `${HIBERNATE}.DynamicInsert`)
  const names = (columns: string[]) => `{ ${columns.map(javaString).join(', ')} }`
  const parts = [`name = ${javaString(table.name)}`]
  if (table.schema) parts.push(`schema = ${javaString(table.schema)}`)
  if (table.uniques.length > 0) {
    imports.add(`${PERSISTENCE}.UniqueConstraint`)
    parts.push(
      `uniqueConstraints = { ${table.uniques.map((unique) => `@UniqueConstraint(${unique.name ? `name = ${javaString(unique.name)}, ` : ''}columnNames = ${names(unique.columns)})`).join(', ')} }`,
    )
  }
  if (table.indexes.length > 0) {
    imports.add(`${PERSISTENCE}.Index`)
    parts.push(
      `indexes = { ${table.indexes.map((index) => `@Index(${index.name ? `name = ${javaString(index.name)}, ` : ''}columnList = ${javaString(index.columns.join(', '))})`).join(', ')} }`,
    )
  }
  const name = jpqlName(info)
  const result = [name === info.entity ? '@Entity' : `@Entity(name = ${javaString(name)})`, `@Table(${parts.join(', ')})`, '@DynamicInsert']
  if (info.key.length > 1) {
    imports.add(`${PERSISTENCE}.IdClass`)
    result.push(`@IdClass(${info.entity}.Key.class)`)
  }
  for (const check of table.checks) {
    imports.add(`${HIBERNATE}.Check`)
    result.push(`@Check(${check.name ? `name = ${javaString(check.name)}, ` : ''}constraints = ${javaString(check.sql)})`)
  }
  return result
}

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new JavaImports(pkg)
  for (const column of info.columns) if (column.javaImport) imports.add(column.javaImport)
  const annotations = classAnnotations(info, imports)
  const fields = info.columns.flatMap((column, index) => [
    index > 0 ? '' : null,
    column.column.type.kind === 'unknown' && `    // TODO: "${column.column.type.sql}" has no JPA type here; it is mapped as text`,
    column.column.type.kind === 'array' && `    // TODO: "${column.column.type.sql}" is kept as its JSON text`,
    ...columnAnnotations(context, info, column, imports).map((line) => `    ${line}`),
    `    private ${column.java} ${column.prop};`,
  ])
  const relations = relationLines(context, info, imports)
  if (info.key.length > 1) imports.add('java.io.Serializable')
  const accessors = info.columns.flatMap((column) => [
    '',
    `    public ${column.java} ${column.getter}() {`,
    `        return ${column.prop};`,
    '    }',
    '',
    `    public void ${column.setter}(${column.java} ${column.prop}) {`,
    `        this.${column.prop} = ${column.prop};`,
    '    }',
  ])
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    `/** A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. */`,
    !info.table.primaryKey && [
      '// The table has no primary key: rows are told apart by all their columns, for reading only, and the',
      '// tests create that key in their own database',
    ],
    ...annotations,
    `public class ${info.entity} {`,
    info.key.length > 1 && [
      `    /** The key of a row: ${info.key.map((column) => column.column.name).join(', ')}. */`,
      `    public record Key(${info.key.map((column) => `${column.java} ${column.prop}`).join(', ')}) implements Serializable {}`,
      '',
    ],
    ...fields,
    ...relations,
    ...accessors,
    '}',
    '',
  )
  return { path: javaPath(pkg, info.entity), content }
}
