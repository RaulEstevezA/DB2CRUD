/**
 * The repositories without an ORM: each one writes its SQL and runs it through sqlx on Db (the pool, or a transaction).
 * Rows are read into the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or
 * after a key; new rows are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a
 * database refusal becomes a Conflict. Mirrors csharp/sql/repository.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import { columnOf, stored, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { keyValue, type Method } from '../repositories.ts'
import { rsString, type RsUses } from '../rust.ts'
import { cast, readColumn, readsDecimals, selected, writeValue } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database === 'postgresql' || context.settings.database === 'sqlite'

/** The mark of the value at a position: `$1::"mood"`, or `?`. */
const mark = (context: Context, column: ColumnInfo, position: number) =>
  context.settings.database === 'postgresql' ? `$${position}${cast(context, column)}` : '?'
/** The mark of a number at a position. */
const numberMark = (context: Context, position: number) => (context.settings.database === 'postgresql' ? `$${position}` : '?')

/** The condition that leaves out rows marked as deleted. */
function softCondition(context: Context, info: TableInfo): string | null {
  if (!info.soft) return null
  const column = q(context, info.soft.column.name)
  return info.soft.column.type.kind === 'boolean' ? `${column} = FALSE` : `${column} IS NULL`
}

function whereSql(conditions: (string | null)[]): string {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? ` WHERE ${present.join(' AND ')}` : ''
}

/** `"id" = $1`, with the marks numbered after the first ones. */
const equals = (context: Context, columns: ColumnInfo[], first = 0) =>
  columns.map((column, index) => `${q(context, column.column.name)} = ${mark(context, column, first + index + 1)}`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** The calls that bind values to a statement. */
const binds = (values: string[]) => values.map((value) => `.bind(${value})`).join('')

/** The key of an entity known to be stored, as the statement takes it. */
const keyValues = (context: Context, info: TableInfo) =>
  info.key.map((column) =>
    column.column.nullable ? optional(context, column) : writeValue(context, column, stored(`entity.${column.field}`, column)),
  )

/** A field of the entity, which may be None, as the statement takes it. */
function optional(context: Context, column: ColumnInfo): string {
  const field = column.copy ? `entity.${column.field}` : `entity.${column.field}.clone()`
  const value = writeValue(context, column, 'value')
  return value === 'value' ? field : `${field}.map(|value| ${value})`
}

/** The functions after the struct: the columns a read selects, how a row becomes an entity, and how writes report a refusal. */
export function sqlHelpers(context: Context, info: TableInfo, methods: Method[], uses: RsUses): string[] {
  const reads = methods.some((method) => method.query.kind !== 'delete')
  const writes = methods.some((method) => ['insert', 'update', 'delete'].includes(method.query.kind))
  if (reads) uses.add('sqlx::Row', 'crate::database::DbRow')
  if (writes) uses.add('sqlx::error::ErrorKind')
  const columns = info.columns.map((column) => selected(context, column)).join(', ')
  return [
    ...(reads
      ? [
          '',
          '/// The columns every read selects.',
          `const COLUMNS: &str = ${rsString(columns)};`,
          '',
          '/// The entity of a row read with COLUMNS.',
          `fn to_entity(row: &DbRow) -> Result<${info.entity}, sqlx::Error> {`,
          `    Ok(${info.entity} {`,
          ...info.columns.map((column, index) => `        ${column.field}: ${readColumn(context, column, index)},`),
          '    })',
          '}',
          '',
          '/// The entities of the rows read with COLUMNS.',
          `fn to_entities(rows: Vec<DbRow>) -> Result<Vec<${info.entity}>, sqlx::Error> {`,
          '    rows.iter().map(to_entity).collect()',
          '}',
        ]
      : []),
    ...(reads && readsDecimals(context, info)
      ? [
          '',
          '/// A decimal, which SQLite keeps as a number, with the scale of its column.',
          'fn decimal(text: &str, scale: Option<u32>) -> Result<rust_decimal::Decimal, sqlx::Error> {',
          '    let mut value = text',
          '        .parse::<rust_decimal::Decimal>()',
          '        .or_else(|_| rust_decimal::Decimal::from_scientific(text))',
          '        .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;',
          '    if let Some(scale) = scale {',
          '        value.rescale(scale);',
          '    }',
          '    Ok(value)',
          '}',
        ]
      : []),
    ...(writes
      ? [
          '',
          '/// A refusal of the database (a unique value, a row still pointed to) becomes a Conflict.',
          'fn refused(error: sqlx::Error) -> DomainError {',
          '    if error.as_database_error().is_some_and(|refusal| !matches!(refusal.kind(), ErrorKind::Other)) {',
          `        DomainError::conflict(${rsString(info.entity)}, &format!("the database refused the change: {error}"), &[])`,
          '    } else {',
          '        error.into()',
          '    }',
          '}',
        ]
      : []),
  ]
}

/** The statement that reads the rows of a FROM, with its values. */
const select = (rest: string, values: string[]) => {
  const text = rest.replace(/\{/g, '{{').replace(/\}/g, '}}')
  return `statement(format!(${rsString(`SELECT {COLUMNS}${text}`)}))${binds(values)}`
}

/** Reads a stored row again by its key, without the soft-delete filter. */
function readBack(context: Context, info: TableInfo): string[] {
  const rest = ` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`
  return [
    `let query = ${select(rest, keyValues(context, info))};`,
    'let row = self.db.one(query).await?.ok_or(sqlx::Error::RowNotFound)?;',
    'Ok(to_entity(&row)?)',
  ]
}

/** The statement of an insert: columns left None take the database's default. */
function insertLines(context: Context, info: TableInfo): string[] {
  const written = info.columns.filter((column) => writable(column))
  const uuids = written.filter((column) => column.column.generated === 'uuid' && column.rs === 'uuid::Uuid')
  const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' && !returns(context)
  const given = (column: ColumnInfo) => {
    const name = rsString(q(context, column.column.name))
    return context.settings.database === 'postgresql' ? `(${name}, ${rsString(cast(context, column))})` : name
  }
  const taken = (column: ColumnInfo) => (column.copy ? `entity.${column.field}` : `entity.${column.field}.clone()`)
  return [
    ...(uuids.length > 0 || identity ? ['let mut entity = entity;'] : []),
    ...uuids.map((column) => `entity.${column.field} = entity.${column.field}.or_else(|| Some(uuid::Uuid::new_v4()));`),
    'let mut given = Vec::new();',
    ...written.flatMap((column) => [`if entity.${column.field}.is_some() {`, `    given.push(${given(column)});`, '}']),
    `let sql = insert_sql(${rsString(table(context, info))}, &given);`,
    `let mut query = statement(${returns(context) ? 'format!("{sql} RETURNING {COLUMNS}")' : 'sql'});`,
    ...written.flatMap((column) => [
      `if let Some(value) = ${taken(column)} {`,
      `    query = query.bind(${writeValue(context, column, 'value')});`,
      '}',
    ]),
  ]
}

export function sqlBody(context: Context, info: TableInfo, method: Method, uses: RsUses): string[] {
  uses.add('crate::database::statement')
  const from = ` FROM ${table(context, info)}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const byValues = columns.map((column) => writeValue(context, column, column.field))
  const soft = softCondition(context, info)
  const order = orderBy(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `let query = ${select(`${from}${whereSql([...equals(context, columns), soft])}`, byValues)};`,
        'let row = self.db.one(query).await?;',
        'Ok(row.as_ref().map(to_entity).transpose()?)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        `let query = ${select(`${from}${whereSql([...equals(context, columns), soft])}${order}`, byValues)};`,
        'Ok(to_entities(self.db.all(query).await?)?)',
      ]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset') {
        uses.add('sqlx::Row')
        const limits = ` LIMIT ${numberMark(context, 1)} OFFSET ${numberMark(context, 2)}`
        return [
          `let query = ${select(`${from}${where}${order}${limits}`, ['limit as i64', 'offset as i64'])};`,
          'let items = to_entities(self.db.all(query).await?)?;',
          `let count = self.db.one(statement(${rsString(`SELECT COUNT(*)${from}${where}`)})).await?.ok_or(sqlx::Error::RowNotFound)?;`,
          'let total = count.try_get::<i64, _>(0)? as u64;',
          'Ok(Page { items, total, offset, limit })',
        ]
      }
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const marks = info.key.map((column, index) => mark(context, column, index + 1))
        const after = key.length === 1 ? `${key[0]} > ${marks[0]}` : `(${key.join(', ')}) > (${marks.join(', ')})`
        const names = info.key.length === 1 ? ['after'] : info.key.map((_, index) => `after${index}`)
        const values = info.key.map((column, index) => writeValue(context, column, names[index]))
        const first = select(`${from}${where}${order} LIMIT ${numberMark(context, 1)}`, ['limit as i64 + 1'])
        const next = select(`${from}${whereSql([soft, after])}${order} LIMIT ${numberMark(context, key.length + 1)}`, [
          ...values,
          'limit as i64 + 1',
        ])
        return [
          'let query = match after {',
          `    None => ${first},`,
          `    Some(${names.length === 1 ? 'after' : `(${names.join(', ')})`}) => ${next},`,
          '};',
          'let mut items = to_entities(self.db.all(query).await?)?;',
          'let more = items.len() as u64 > limit;',
          'items.truncate(limit as usize);',
          `let next = if more { items.last().map(|last| ${keyValue(info, 'last')}) } else { None };`,
          'Ok(CursorPage { items, next })',
        ]
      }
      return [`let query = ${select(`${from}${where}${order}`, [])};`, 'Ok(to_entities(self.db.all(query).await?)?)']
    }
    case 'insert': {
      uses.add('crate::database::insert_sql')
      const prepare = insertLines(context, info)
      if (returns(context))
        return [
          ...prepare,
          'let row = self.db.one(query).await.map_err(refused)?.ok_or(sqlx::Error::RowNotFound)?;',
          'Ok(to_entity(&row)?)',
        ]
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      return [
        ...prepare,
        `${identity ? 'let result = ' : ''}self.db.run(query).await.map_err(refused)?;`,
        ...(identity ? [`entity.${identity.field} = entity.${identity.field}.or(Some(result.last_insert_id() as ${identity.rs}));`] : []),
        ...readBack(context, info),
      ]
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const now = returns(context) ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP(6)'
      const sets = [...equals(context, changes), ...stamps.map((column) => `${q(context, column.column.name)} = ${now}`)]
      if (sets.length === 0) return readBack(context, info)
      const sql = rsString(`UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key, changes.length))}`)
      const values = [...changes.map((column) => optional(context, column)), ...keyValues(context, info)]
      return [`let query = statement(${sql})${binds(values)};`, 'self.db.run(query).await.map_err(refused)?;', ...readBack(context, info)]
    }
    case 'delete': {
      const sql = rsString(`DELETE${from}${whereSql(equals(context, info.key))}`)
      return [`let query = statement(${sql})${binds(keyValues(context, info))};`, 'self.db.run(query).await.map_err(refused)?;', 'Ok(())']
    }
    default:
      return ['unimplemented!()']
  }
}
