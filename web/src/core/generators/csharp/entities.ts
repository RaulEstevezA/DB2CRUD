/**
 * The entity of each table (a plain class with a property per column) and `AppDbContext`, whose Fluent API maps
 * every table as the database has it: exact table and column names, lengths, precision, keys (none for a table
 * without one), unique indexes, indexes, CHECK constraints, foreign keys with their actions, enums of PostgreSQL,
 * and the values the database fills, which EF Core reads back after an insert.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { DbEnum } from '../../schema/types.ts'
import { lines, type Line } from '../types.ts'
import { csString, CsUsings, pascalName } from './csharp.ts'
import { columnOf, findInfo, namespaceOf, pathOf, writesEntities, type ColumnInfo, type Context, type TableInfo } from './context.ts'

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const content = lines(
    `namespace ${ns};`,
    '',
    `/// <summary>A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. Its mapping is in AppDbContext.</summary>`,
    `public class ${info.entity}`,
    '{',
    ...info.columns.flatMap((column, index) => [
      index > 0 ? '' : null,
      column.column.comment && `    /// <summary>${column.column.comment}</summary>`,
      column.column.type.kind === 'unknown' && `    // TODO: "${column.column.type.sql}" has no EF Core type here; it is mapped as text`,
      column.column.type.kind === 'array' && `    // TODO: "${column.column.type.sql}" is kept as its JSON text`,
      `    public ${column.propType} ${column.prop} { get; set; }${!column.optional && !column.valueType ? ' = null!;' : ''}`,
    ]),
    '}',
    '',
  )
  return { path: pathOf(ns, info.entity), content }
}

// AppDbContext

export function nativeEnum(context: Context, column: ColumnInfo): DbEnum | undefined {
  const type = column.column.type
  if (type.kind !== 'enum' || context.settings.database === 'sqlite') return undefined
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  return item?.storage === 'native' ? item : undefined
}

const quoteSql = (text: string) => `'${text.replace(/'/g, "''")}'`

/** A literal default in the property's C# type. */
function defaultLiteral(column: ColumnInfo, value: string | number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  const text = String(value)
  switch (column.cs) {
    case 'long':
      return `${text}L`
    case 'short':
      return `(short)${text}`
    case 'decimal':
      return `${text}m`
    case 'float':
      return `${text}f`
    case 'double':
      return text.includes('.') ? text : `${text}.0`
    case 'int':
    case 'bool':
      return text
    default:
      return csString(text)
  }
}

const mysql = (context: Context) => context.settings.database === 'mysql' || context.settings.database === 'mariadb'

/** The calls that map one property. */
function propertyLines(context: Context, info: TableInfo, column: ColumnInfo): string[] {
  const db = column.column
  const type = db.type
  const calls = [`entity.Property(e => e.${column.prop})`, `.HasColumnName(${csString(db.name)})`]
  if (type.kind === 'text' && type.length !== undefined) calls.push(`.HasMaxLength(${type.length})`)
  if (type.kind === 'text' && type.fixed) calls.push('.IsFixedLength()')
  if (type.kind === 'binary' && type.length !== undefined) calls.push(`.HasMaxLength(${type.length})`)
  if (type.kind === 'decimal' && type.precision !== undefined) calls.push(`.HasPrecision(${type.precision}, ${type.scale ?? 0})`)
  const database = context.settings.database
  if ((type.kind === 'json' || type.kind === 'array') && database !== 'sqlite')
    calls.push(`.HasColumnType(${csString(database === 'postgresql' && !/^json$/i.test(type.sql) ? 'jsonb' : 'json')})`)
  // Npgsql maps a DateTime to a timestamp with a time zone unless told otherwise
  if (type.kind === 'datetime' && !type.timezone && database === 'postgresql') calls.push('.HasColumnType("timestamp without time zone")')
  const enumType = nativeEnum(context, column)
  if (enumType)
    calls.push(
      `.HasColumnType(${csString(database === 'postgresql' ? enumType.name : `enum(${enumType.values.map(quoteSql).join(', ')})`)})`,
    )
  // Npgsql sends a value of an enum of PostgreSQL as that type only when it is a C# enum: the property keeps the text
  if (enumType && database === 'postgresql') {
    const name = enumTypeName(context, enumType)
    calls.push(`.HasConversion(value => PgEnums.To${name}(value), value => PgEnums.From${name}(value))`)
  }
  if (column.optional && !db.nullable) calls.push('.IsRequired()')
  if (db.generated === 'identity' && !info.key.includes(column)) calls.push('.ValueGeneratedOnAdd()')
  if (db.generated === 'now' || db.generated === 'onUpdateNow')
    // MySQL's datetime(6) takes the current time with the same precision
    calls.push(`.HasDefaultValueSql(${csString(mysql(context) ? 'CURRENT_TIMESTAMP(6)' : 'CURRENT_TIMESTAMP')})`)
  else if (typeof db.generated === 'object') calls.push(`.HasComputedColumnSql(${csString(db.generated.computed)}, stored: true)`)
  else if (db.default?.kind === 'literal' && db.default.value !== null)
    calls.push(`.HasDefaultValue(${defaultLiteral(column, db.default.value)})`)
  else if (db.default?.kind === 'expression') calls.push(`.HasDefaultValueSql(${csString(db.default.sql)})`)
  if (db.comment) calls.push(`.HasComment(${csString(db.comment)})`)
  return [`${calls[0]}${calls.slice(1).join('')};`]
}

const DELETE: Record<string, string> = {
  cascade: 'Cascade',
  'set null': 'SetNull',
  restrict: 'Restrict',
  'no action': 'NoAction',
}

const members = (info: TableInfo, names: string[]) =>
  names.length === 1
    ? `e => e.${columnOf(info, names[0]).prop}`
    : `e => new { ${names.map((name) => `e.${columnOf(info, name).prop}`).join(', ')} }`

function entityBlock(context: Context, info: TableInfo): Line[] {
  const { table } = info
  const checks = table.checks.map(
    (check, position) => `t.HasCheckConstraint(${csString(check.name ?? `ck_${table.name}_${position + 1}`)}, ${csString(check.sql)})`,
  )
  const toTable = `entity.ToTable(${csString(table.name)}${table.schema ? `, ${csString(table.schema)}` : ''}${
    checks.length > 0 ? `, t =>\n            {\n${checks.map((check) => `                ${check};`).join('\n')}\n            }` : ''
  });`
  const result: Line[] = [`        model.Entity<${info.entity}>(entity =>`, '        {', `            ${toTable}`]
  if (table.primaryKey) result.push(`            entity.HasKey(${members(info, table.primaryKey)});`)
  else result.push('            // The table has no primary key: EF Core reads it, and never writes it', '            entity.HasNoKey();')
  for (const column of info.columns) result.push(...propertyLines(context, info, column).map((line) => `            ${line}`))
  for (const unique of table.uniques)
    result.push(
      `            entity.HasIndex(${members(info, unique.columns)}).IsUnique()${unique.name ? `.HasDatabaseName(${csString(unique.name)})` : ''};`,
    )
  for (const index of table.indexes)
    result.push(
      `            entity.HasIndex(${members(info, index.columns)})${index.name ? `.HasDatabaseName(${csString(index.name)})` : ''};`,
    )
  if (table.primaryKey)
    for (const key of table.foreignKeys) {
      const parent = findInfo(context, key.references.table)
      if (!parent || !parent.table.primaryKey) continue
      const toKey = parent.table.primaryKey.join(',') === key.references.columns.join(',')
      const action = DELETE[key.onDelete ?? 'no action']
      const chain = [
        `            entity.HasOne<${parent.entity}>()`,
        '                .WithMany()',
        `                .HasForeignKey(${members(info, key.columns)})`,
        !toKey && `                .HasPrincipalKey(${members(parent, key.references.columns)})`,
        key.onDelete === 'set default' && '                // TODO: the database sets the default on delete; EF Core has no such action',
        `                .OnDelete(DeleteBehavior.${action ?? 'NoAction'})`,
        key.name && `                .HasConstraintName(${csString(key.name)})`,
      ].filter((line): line is string => typeof line === 'string')
      chain[chain.length - 1] = `${chain[chain.length - 1]};`
      result.push(...chain)
    }
  result.push('        });')
  return result
}

/** The enums of PostgreSQL the tables use. */
export function pgEnums(context: Context): DbEnum[] {
  if (context.settings.database !== 'postgresql') return []
  return context.schema.enums.filter((item) =>
    context.tables.some((info) => info.columns.some((column) => nativeEnum(context, column) === item)),
  )
}

/** The C# enum of an enum of PostgreSQL: `TicketState`, or `TicketStateEnum` when a table has that name. */
export function enumTypeName(context: Context, item: DbEnum): string {
  const name = pascalName(item.name)
  return context.tables.some((info) => info.entity === name) ? `${name}Enum` : name
}

/** The members of a C# enum, one per value, each a valid and distinct name. */
function enumMembers(item: DbEnum): string[] {
  const used = new Set<string>()
  return item.values.map((value) => {
    const base = /^[A-Za-z_]/.test(pascalName(value)) ? pascalName(value) : `Value${pascalName(value)}`
    let name = base
    for (let index = 2; used.has(name); index++) name = `${base}${index}`
    used.add(name)
    return name
  })
}

/** `PgEnums.cs`: a C# enum per enum of PostgreSQL (so Npgsql sends values as that type) and the conversions from the text the entities keep. */
export function pgEnumsFile(context: Context): GeneratedFile | null {
  const enums = pgEnums(context)
  if (enums.length === 0 || !writesEntities(context)) return null
  const types = enums.flatMap((item) => {
    const name = enumTypeName(context, item)
    const members = enumMembers(item)
    return [
      '',
      `/// <summary>The "${item.name}" enum of the database.</summary>`,
      `public enum ${name}`,
      '{',
      ...item.values.map((value, index) => `    [PgName(${csString(value)})] ${members[index]},`),
      '}',
    ]
  })
  const conversions = enums.flatMap((item) => {
    const name = enumTypeName(context, item)
    const members = enumMembers(item)
    return [
      '',
      `    public static ${name} To${name}(string value) => value switch`,
      '    {',
      ...item.values.map((value, index) => `        ${csString(value)} => ${name}.${members[index]},`),
      `        _ => throw new ArgumentOutOfRangeException(nameof(value), value, ${csString(`not a value of ${item.name}`)}),`,
      '    };',
      '',
      `    public static string From${name}(${name} value) => value switch`,
      '    {',
      ...item.values.map((value, index) => `        ${name}.${members[index]} => ${csString(value)},`),
      `        _ => throw new ArgumentOutOfRangeException(nameof(value), value, ${csString(`not a value of ${item.name}`)}),`,
      '    };',
    ]
  })
  return {
    path: pathOf(context.base, 'PgEnums'),
    content: lines(
      'using NpgsqlTypes;',
      '',
      `namespace ${context.base};`,
      ...types,
      '',
      '/// <summary>The values of the enums of the database as the entities keep them (text), and back.</summary>',
      'public static class PgEnums',
      '{',
      ...conversions.slice(1),
      '}',
      '',
    ),
  }
}

/** `AppDbContext`: a DbSet per table and the mapping of every table. */
export function dbContextFile(context: Context): GeneratedFile {
  const ns = context.base
  const usings = new CsUsings(ns).add('Microsoft.EntityFrameworkCore')
  for (const info of context.tables) usings.add(namespaceOf(context, info, 'entity'))
  const enums = pgEnums(context)
  const blocks = writesEntities(context)
    ? context.tables.flatMap((info, index) => [index > 0 ? '' : null, ...entityBlock(context, info)])
    : []
  const content = lines(
    usings.write(),
    '',
    `namespace ${ns};`,
    '',
    '/// <summary>The tables of the database, mapped as the database has them. It never migrates: the database already exists.</summary>',
    'public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)',
    '{',
    ...context.tables.map((info) => `    public DbSet<${info.entity}> ${info.attr} => Set<${info.entity}>();`),
    '',
    '    protected override void OnModelCreating(ModelBuilder model)',
    '    {',
    ...enums.map(
      (item) =>
        `        model.HasPostgresEnum(${csString(item.name)}, new[] { ${item.values.map((value) => csString(value)).join(', ')} });`,
    ),
    enums.length > 0 && '',
    ...blocks,
    '    }',
    '}',
    '',
  )
  return { path: pathOf(ns, 'AppDbContext'), content }
}
