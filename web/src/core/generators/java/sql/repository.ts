/**
 * The repositories without an ORM: each one writes its SQL and runs it through Sql over a JDBC Connection (the
 * application's, or one in a transaction). Rows are read into the plain entities column by column; reads leave out
 * rows marked as deleted; pages go by offset or after a key; new rows are read back (with RETURNING on PostgreSQL, by
 * their key elsewhere); and a database refusal becomes a ConflictException. Mirrors typescript/sql/repository.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import type { Line } from '../../types.ts'
import { javaString, type JavaImports } from '../java.ts'
import { columnOf, errorsPackage, sqlRepositoryClass, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import type { Method } from '../repositories.ts'
import { readCall } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database === 'postgresql'

/** `"id", "name"`: the columns every read selects, in the order fill reads them. */
const selectList = (context: Context, info: TableInfo) => info.columns.map((column) => q(context, column.column.name)).join(', ')

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

const equals = (context: Context, columns: ColumnInfo[]) => columns.map((column) => `${q(context, column.column.name)} = ?`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** The arguments after the SQL: the reader, when the statement reads rows, and the values. */
const args = (values: string[]) => values.map((value) => `, ${value}`).join('')

const keyValues = (info: TableInfo, target = 'entity') => info.key.map((column) => `${target}.${column.getter}()`)

/** The columns a read selects, and the entity of a row. */
export function sqlHead(context: Context, info: TableInfo, imports: JavaImports): Line[] {
  imports.add('java.sql.Connection', `${context.base}.Sql`)
  return [
    '    /** The columns every read selects. */',
    `    private static final String COLUMNS = ${javaString(selectList(context, info))};`,
    '',
    '    protected final Connection connection;',
    '',
    `    public ${sqlRepositoryClass(info)}(Connection connection) {`,
    '        this.connection = connection;',
    '    }',
  ]
}

/** How a row read with COLUMNS becomes an entity. */
export function sqlTail(context: Context, info: TableInfo, imports: JavaImports): Line[] {
  imports.add('java.sql.ResultSet', 'java.sql.SQLException')
  return [
    '',
    `    /** The ${info.entity} of a row read with COLUMNS. */`,
    `    private static ${info.entity} toEntity(ResultSet row) throws SQLException {`,
    `        return fill(row, new ${info.entity}());`,
    '    }',
    '',
    '    /** Reads a row selected with COLUMNS into entity. */',
    `    private static ${info.entity} fill(ResultSet row, ${info.entity} entity) throws SQLException {`,
    ...info.columns.map((column, index) => `        entity.${column.setter}(${readCall(context, column, index + 1)});`),
    '        return entity;',
    '    }',
  ]
}

/** A write, with a refusal of the database turned into a ConflictException. */
function write(context: Context, info: TableInfo, action: Line[], imports: JavaImports, after: Line[] = []): Line[] {
  imports.add(`${errorsPackage(context)}.ConflictException`)
  return [
    'try {',
    ...action.map((line) => (typeof line === 'string' ? `    ${line}` : line)),
    '} catch (Sql.RefusedException error) {',
    `    throw new ConflictException("${info.entity}", "the database refused the change: " + error.getMessage());`,
    '}',
    ...after,
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter, into the entity. */
function readBack(context: Context, info: TableInfo): Line[] {
  const sql = javaString(` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`)
  return [
    `return Sql.one(connection, "SELECT " + COLUMNS + ${sql}, (row) -> fill(row, entity)${args(keyValues(info))})`,
    `        .orElseThrow(() -> new IllegalStateException("The ${info.entity} just written is not there"));`,
  ]
}

/** `(long) id` turned into the type of the key. */
function fromId(java: string): string {
  if (java === 'Integer') return 'id.intValue()'
  if (java === 'Short') return 'id.shortValue()'
  return 'id'
}

export function sqlBody(context: Context, info: TableInfo, method: Method, imports: JavaImports): Line[] {
  const entity = info.entity
  const reader = `${sqlRepositoryClass(info)}::toEntity`
  const from = ` FROM ${table(context, info)}`
  const select = (rest: string) => `"SELECT " + COLUMNS + ${javaString(`${from}${rest}`)}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const byValues = args(columns.map((column) => column.prop))
  const soft = softCondition(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return Sql.one(connection, ${select(whereSql([...equals(context, columns), soft]))}, ${reader}${byValues});`]
    case 'listByParent':
    case 'findAllBy':
      return [
        `return Sql.all(connection, ${select(`${whereSql([...equals(context, columns), soft])}${orderBy(context, info)}`)}, ${reader}${byValues});`,
      ]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset') {
        imports.add('java.util.List')
        return [
          `List<${entity}> items = Sql.all(connection, ${select(`${where}${orderBy(context, info)} LIMIT ? OFFSET ?`)}, ${reader}, limit, offset);`,
          `long total = Sql.one(connection, ${javaString(`SELECT COUNT(*)${from}${where}`)}, (row) -> row.getLong(1)).orElse(0L);`,
          'return new Page<>(items, total, offset, limit);',
        ]
      }
      if (context.settings.paging === 'cursor') {
        imports.add('java.util.ArrayList', 'java.util.List')
        const key = info.key.map((column) => q(context, column.column.name))
        const after = key.length === 1 ? `${key[0]} > ?` : `(${key.join(', ')}) > (${key.map(() => '?').join(', ')})`
        const afterValues = info.key.map((_, index) => `after.get(${index})`)
        return [
          `List<${entity}> rows = after == null`,
          `        ? Sql.all(connection, ${select(`${where}${orderBy(context, info)} LIMIT ?`)}, ${reader}, limit + 1)`,
          `        : Sql.all(connection, ${select(`${whereSql([soft, after])}${orderBy(context, info)} LIMIT ?`)}, ${reader}${args(afterValues)}, limit + 1);`,
          `List<${entity}> items = new ArrayList<>(rows.subList(0, Math.min(limit, rows.size())));`,
          `${entity} last = items.isEmpty() ? null : items.get(items.size() - 1);`,
          `return new CursorPage<>(items, rows.size() > limit ? List.of(${info.key.map((column) => `last.${column.getter}()`).join(', ')}) : null);`,
        ]
      }
      return [`return Sql.all(connection, ${select(`${where}${orderBy(context, info)}`)}, ${reader});`]
    }
    case 'insert': {
      imports.add('java.util.ArrayList', 'java.util.Collections', 'java.util.List')
      const written = info.columns.filter(writable)
      const uuids = written.filter((column) => column.column.generated === 'uuid')
      if (uuids.length > 0) imports.add('java.util.UUID')
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      const into = `INSERT INTO ${table(context, info)}`
      const empty = context.settings.database === 'mysql' || context.settings.database === 'mariadb' ? ' () VALUES ()' : ' DEFAULT VALUES'
      // Values left null take the database's default
      const prepare: Line[] = [
        ...uuids.map((column) => `if (entity.${column.getter}() == null) entity.${column.setter}(UUID.randomUUID());`),
        'List<String> names = new ArrayList<>();',
        'List<Object> values = new ArrayList<>();',
        ...written.map(
          (column) =>
            `if (entity.${column.getter}() != null) { names.add(${javaString(q(context, column.column.name))}); values.add(entity.${column.getter}()); }`,
        ),
        'String sql = names.isEmpty()',
        `        ? ${javaString(`${into}${empty}`)}`,
        `        : ${javaString(`${into} (`)} + String.join(", ", names) + ") VALUES (" + String.join(", ", Collections.nCopies(names.size(), "?")) + ")";`,
      ]
      if (returns(context))
        return write(
          context,
          info,
          [
            ...prepare,
            'return Sql.one(connection, sql + " RETURNING " + COLUMNS, (row) -> fill(row, entity), values.toArray())',
            `        .orElseThrow(() -> new IllegalStateException("The ${entity} just written is not there"));`,
          ],
          imports,
        )
      return write(
        context,
        info,
        [
          ...prepare,
          identity ? 'Long id = Sql.insert(connection, sql, values.toArray());' : 'Sql.insert(connection, sql, values.toArray());',
          identity && `if (entity.${identity.getter}() == null && id != null) entity.${identity.setter}(${fromId(identity.java)});`,
        ],
        imports,
        readBack(context, info),
      )
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const sets = [
        ...changes.map((column) => `${q(context, column.column.name)} = ?`),
        ...stamps.map((column) => `${q(context, column.column.name)} = CURRENT_TIMESTAMP`),
      ]
      if (sets.length === 0) return readBack(context, info)
      const sql = `UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key))}`
      const values = [...changes.map((column) => `entity.${column.getter}()`), ...keyValues(info)]
      return write(context, info, [`Sql.run(connection, ${javaString(sql)}${args(values)});`], imports, readBack(context, info))
    }
    case 'delete':
      return write(
        context,
        info,
        [`Sql.run(connection, ${javaString(`DELETE${from}${whereSql(equals(context, info.key))}`)}${args(keyValues(info))});`],
        imports,
      )
    default:
      return ['throw new UnsupportedOperationException();']
  }
}
