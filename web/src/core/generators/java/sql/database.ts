/**
 * The database layer of a Java project without an ORM: `Database`, the JDBC connection to DATABASE_URL; `Sql`, what
 * the repositories run their SQL with (statements and their values as each driver takes them, rows read by the type of
 * each column, and the database's refusals); and the entities, plain classes with a property per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Dialect } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { javaPath, javaString, JavaImports } from '../java.ts'
import { packageOf, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { file } from '../support.ts'

const URLS: Record<string, string> = {
  postgresql: 'jdbc:postgresql://localhost:5432/app',
  mysql: 'jdbc:mysql://localhost:3306/app',
  mariadb: 'jdbc:mariadb://localhost:3306/app',
  sqlite: 'jdbc:sqlite:app.db?foreign_keys=true',
}

const isMysql = (database: Dialect) => database === 'mysql' || database === 'mariadb'

/** `Database`: the JDBC connection to the database DATABASE_URL names. */
function databaseFile(context: Context): GeneratedFile {
  const postgres = context.settings.database === 'postgresql'
  return file(
    context.base,
    'Database',
    [
      '/** The database DATABASE_URL names (a JDBC URL; DATABASE_USER and DATABASE_PASSWORD), through its JDBC driver. */',
      'public final class Database {',
      `    public static final String DEFAULT_URL = ${javaString(URLS[context.settings.database] ?? URLS.postgresql)};`,
      '',
      '    private Database() {}',
      '',
      '    /** A connection to the database at url; in production, take connections from a pool such as HikariCP. */',
      '    public static Connection connect(String url, String user, String password) {',
      '        Properties properties = new Properties();',
      '        if (user != null) properties.setProperty("user", user);',
      '        if (password != null) properties.setProperty("password", password);',
      ...(postgres
        ? [
            '        // Texts are sent without a type, so PostgreSQL reads each one as its column has it: an enum, JSON',
            '        properties.setProperty("stringtype", "unspecified");',
          ]
        : []),
      '        try {',
      '            return DriverManager.getConnection(url, properties);',
      '        } catch (SQLException error) {',
      '            throw new Sql.DatabaseException(error);',
      '        }',
      '    }',
      '',
      '    /** A connection to DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD. */',
      '    public static Connection open() {',
      '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
      '        return connect(url, System.getenv("DATABASE_USER"), System.getenv("DATABASE_PASSWORD"));',
      '    }',
      '}',
    ],
    new JavaImports(context.base).add('java.sql.Connection', 'java.sql.DriverManager', 'java.sql.SQLException', 'java.util.Properties'),
  )
}

/** The reader of each Java type: its name in Sql, its body, and what it imports. */
interface Reader {
  name: string
  java: string
  body: string[]
  imports: string[]
}

/** A reader of a primitive JDBC getter, which gives 0 or false for NULL. */
const primitive = (java: string, getter: string, type: string): Reader => ({
  name: `get${java}`,
  java,
  body: [`${type} value = row.${getter}(index);`, 'return row.wasNull() ? null : value;'],
  imports: [],
})

/** A reader of a text the driver gives, parsed into the type. */
const parsed = (java: string, javaImport: string, parse: string): Reader => ({
  name: `get${java}`,
  java,
  body: ['String text = row.getString(index);', `return text == null ? null : ${parse};`],
  imports: [javaImport],
})

/** A reader through the driver's own conversion to the type (JDBC 4.2). */
const object = (java: string, javaImport: string): Reader => ({
  name: `get${java}`,
  java,
  body: [`return row.getObject(index, ${java}.class);`],
  imports: [javaImport],
})

/** How each Java type of a column is read on each database. */
function readerOf(database: Dialect, java: string): Reader {
  const sqlite = database === 'sqlite'
  const mysql = isMysql(database)
  switch (java) {
    case 'Long':
      return primitive('Long', 'getLong', 'long')
    case 'Integer':
      return primitive('Integer', 'getInt', 'int')
    case 'Short':
      return primitive('Short', 'getShort', 'short')
    case 'Double':
      return primitive('Double', 'getDouble', 'double')
    case 'Float':
      return primitive('Float', 'getFloat', 'float')
    case 'Boolean':
      return primitive('Boolean', 'getBoolean', 'boolean')
    case 'byte[]':
      return { name: 'getBytes', java, body: ['return row.getBytes(index);'], imports: [] }
    case 'BigDecimal':
      // SQLite keeps a decimal as a number: its scale is given back from the column's
      return sqlite
        ? {
            name: 'getBigDecimal',
            java,
            body: [
              'String text = row.getString(index);',
              'if (text == null) return null;',
              'BigDecimal value = new BigDecimal(text);',
              'return scale < 0 ? value : value.setScale(scale, RoundingMode.HALF_UP);',
            ],
            imports: ['java.math.BigDecimal', 'java.math.RoundingMode'],
          }
        : { name: 'getBigDecimal', java, body: ['return row.getBigDecimal(index);'], imports: ['java.math.BigDecimal'] }
    case 'UUID':
      return database === 'postgresql' ? object('UUID', 'java.util.UUID') : parsed('UUID', 'java.util.UUID', 'UUID.fromString(text)')
    case 'LocalDate':
      return sqlite ? parsed('LocalDate', 'java.time.LocalDate', 'LocalDate.parse(text)') : object('LocalDate', 'java.time.LocalDate')
    case 'LocalTime':
      return sqlite ? parsed('LocalTime', 'java.time.LocalTime', 'LocalTime.parse(text)') : object('LocalTime', 'java.time.LocalTime')
    case 'LocalDateTime':
      // SQLite's CURRENT_TIMESTAMP writes a space between the date and the time
      return sqlite
        ? parsed('LocalDateTime', 'java.time.LocalDateTime', "LocalDateTime.parse(text.replace(' ', 'T'))")
        : object('LocalDateTime', 'java.time.LocalDateTime')
    case 'OffsetDateTime':
      if (database === 'postgresql') return object('OffsetDateTime', 'java.time.OffsetDateTime')
      // MySQL and MariaDB keep no zone: the times are in UTC
      if (mysql)
        return {
          name: 'getOffsetDateTime',
          java,
          body: [
            'LocalDateTime value = row.getObject(index, LocalDateTime.class);',
            'return value == null ? null : value.atOffset(ZoneOffset.UTC);',
          ],
          imports: ['java.time.LocalDateTime', 'java.time.OffsetDateTime', 'java.time.ZoneOffset'],
        }
      return {
        name: 'getOffsetDateTime',
        java,
        body: [
          'String text = row.getString(index);',
          'if (text == null) return null;',
          "String iso = text.replace(' ', 'T');",
          '// A time without its zone (CURRENT_TIMESTAMP) is in UTC',
          'return iso.matches(".*(Z|[+-]\\\\d\\\\d:?\\\\d\\\\d)$") ? OffsetDateTime.parse(iso) : LocalDateTime.parse(iso).atOffset(ZoneOffset.UTC);',
        ],
        imports: ['java.time.LocalDateTime', 'java.time.OffsetDateTime', 'java.time.ZoneOffset'],
      }
    case 'OffsetTime':
      if (database === 'postgresql') return object('OffsetTime', 'java.time.OffsetTime')
      return {
        name: 'getOffsetTime',
        java,
        body: ['String text = row.getString(index);', 'return text == null ? null : LocalTime.parse(text).atOffset(ZoneOffset.UTC);'],
        imports: ['java.time.LocalTime', 'java.time.OffsetTime', 'java.time.ZoneOffset'],
      }
    default:
      return { name: 'getString', java: 'String', body: ['return row.getString(index);'], imports: [] }
  }
}

/** The name of the reader of a column in Sql, and its arguments after the row: its position, and the scale of a decimal on SQLite. */
export function readCall(context: Context, column: ColumnInfo, index: number): string {
  const reader = readerOf(context.settings.database, column.java)
  const scale =
    reader.name === 'getBigDecimal' && context.settings.database === 'sqlite'
      ? `, ${column.column.type.kind === 'decimal' && column.column.type.scale !== undefined ? column.column.type.scale : -1}`
      : ''
  return `Sql.${reader.name}(row, ${index}${scale})`
}

/** How each driver takes the values of the entities: what it cannot take is turned into what the column keeps. */
function valueLines(database: Dialect): string[] {
  if (database === 'postgresql') return ['return value;']
  if (isMysql(database))
    return [
      'if (value instanceof UUID uuid) return uuid.toString();',
      '// MySQL and MariaDB keep no zone: the times are written in UTC',
      'if (value instanceof OffsetDateTime time) return time.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime();',
      'if (value instanceof OffsetTime time) return time.withOffsetSameInstant(ZoneOffset.UTC).toLocalTime();',
      'return value;',
    ]
  return [
    '// SQLite keeps dates, times and uuids as their text, and decimals as numbers',
    'if (value instanceof UUID || value instanceof TemporalAccessor) return value.toString();',
    'if (value instanceof BigDecimal decimal) return decimal.toPlainString();',
    'return value;',
  ]
}

/** Whether the database refused a write, from the error of its driver. */
function refusalLines(database: Dialect): string[] {
  if (database === 'postgresql')
    return ['// SQLSTATE class 23: integrity constraint violation', 'return state != null && state.startsWith("23");']
  if (isMysql(database))
    return [
      '// SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)',
      'return (state != null && state.startsWith("23")) || error.getErrorCode() == 3819 || error.getErrorCode() == 4025;',
    ]
  return ['// SQLITE_CONSTRAINT, whatever its extended code', 'return (error.getErrorCode() & 0xff) == 19;']
}

/** How an insert gives back the id the database gave the new row, on MySQL, MariaDB and SQLite (PostgreSQL uses RETURNING). */
function insertLines(database: Dialect): string[] {
  if (database === 'sqlite')
    return [
      '    try (PreparedStatement statement = prepare(connection, sql, values)) {',
      '        statement.executeUpdate();',
      '    } catch (SQLException error) {',
      '        throw failure(error);',
      '    }',
      "    // The row id of the connection's last insert, which is the key of a table numbered by SQLite",
      '    return one(connection, "SELECT last_insert_rowid()", (row) -> row.getLong(1)).orElse(null);',
    ]
  return [
    '    try (PreparedStatement statement = connection.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) {',
    '        bind(statement, values);',
    '        statement.executeUpdate();',
    '        try (ResultSet keys = statement.getGeneratedKeys()) {',
    '            return keys.next() ? keys.getLong(1) : null;',
    '        }',
    '    } catch (SQLException error) {',
    '        throw failure(error);',
    '    }',
  ]
}

/** `Sql`: what the repositories run their SQL with. */
function sqlFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const postgres = database === 'postgresql'
  const imports = new JavaImports(context.base).add(
    'java.sql.Connection',
    'java.sql.PreparedStatement',
    'java.sql.ResultSet',
    'java.sql.SQLException',
    'java.util.ArrayList',
    'java.util.List',
    'java.util.Optional',
  )
  if (!postgres) imports.add('java.sql.Statement')
  if (isMysql(database)) imports.add('java.util.UUID', 'java.time.OffsetDateTime', 'java.time.OffsetTime', 'java.time.ZoneOffset')
  if (database === 'sqlite') imports.add('java.util.UUID', 'java.time.temporal.TemporalAccessor', 'java.math.BigDecimal')
  const readers = new Map<string, Reader>()
  for (const info of context.tables)
    for (const column of info.columns) {
      const reader = readerOf(database, column.java)
      readers.set(reader.name, reader)
    }
  const order = ['getLong', 'getInteger', 'getShort', 'getDouble', 'getFloat', 'getBoolean', 'getString', 'getBigDecimal', 'getBytes']
  const sorted = [...readers.values()].sort(
    (a, b) =>
      (order.indexOf(a.name) + 1 || order.length + 1) - (order.indexOf(b.name) + 1 || order.length + 1) || (a.name < b.name ? -1 : 1),
  )
  const readerLines = sorted.flatMap((reader) => {
    for (const item of reader.imports) imports.add(item)
    const scale = reader.name === 'getBigDecimal' && database === 'sqlite' ? ', int scale' : ''
    return [
      '',
      `    /** The ${reader.java} at index of a row, or null. */`,
      `    public static ${reader.java} ${reader.name}(ResultSet row, int index${scale}) throws SQLException {`,
      ...reader.body.map((line) => `        ${line}`),
      '    }',
    ]
  })
  const body: (Line | Line[])[] = [
    "/** What the repositories run their SQL with, over JDBC: statements and their values, rows read into entities, and the database's refusals. */",
    'public final class Sql {',
    '    private Sql() {}',
    '',
    '    /** Reads a row of a result. */',
    '    @FunctionalInterface',
    '    public interface Reader<T> {',
    '        T read(ResultSet row) throws SQLException;',
    '    }',
    '',
    '    /** The database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
    '    public static final class RefusedException extends RuntimeException {',
    '        public RefusedException(SQLException cause) {',
    '            super(cause.getMessage(), cause);',
    '        }',
    '    }',
    '',
    '    /** Any other failure of the database. */',
    '    public static final class DatabaseException extends RuntimeException {',
    '        public DatabaseException(SQLException cause) {',
    '            super(cause.getMessage(), cause);',
    '        }',
    '    }',
    '',
    '    /** Every row of a query. */',
    '    public static <T> List<T> all(Connection connection, String sql, Reader<T> reader, Object... values) {',
    '        try (PreparedStatement statement = prepare(connection, sql, values); ResultSet rows = statement.executeQuery()) {',
    '            List<T> result = new ArrayList<>();',
    '            while (rows.next()) result.add(reader.read(rows));',
    '            return result;',
    '        } catch (SQLException error) {',
    '            throw failure(error);',
    '        }',
    '    }',
    '',
    '    /** The first row of a query, if there is one. */',
    '    public static <T> Optional<T> one(Connection connection, String sql, Reader<T> reader, Object... values) {',
    '        List<T> rows = all(connection, sql, reader, values);',
    '        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));',
    '    }',
    '',
    '    /** Runs a statement that reads nothing back. */',
    '    public static void run(Connection connection, String sql, Object... values) {',
    '        try (PreparedStatement statement = prepare(connection, sql, values)) {',
    '            statement.executeUpdate();',
    '        } catch (SQLException error) {',
    '            throw failure(error);',
    '        }',
    '    }',
    !postgres && [
      '',
      '    /** Runs an insert; the id the database gave the new row, when it numbers them. */',
      '    public static Long insert(Connection connection, String sql, Object... values) {',
      ...insertLines(database).map((line) => `    ${line}`),
      '    }',
    ],
    '',
    '    /** The error of the database, as a RefusedException when it refused a write. */',
    '    public static RuntimeException failure(SQLException error) {',
    '        return isRefusal(error) ? new RefusedException(error) : new DatabaseException(error);',
    '    }',
    '',
    '    private static boolean isRefusal(SQLException error) {',
    '        String state = error.getSQLState();',
    ...refusalLines(database).map((line) => `        ${line}`),
    '    }',
    '',
    '    private static PreparedStatement prepare(Connection connection, String sql, Object[] values) throws SQLException {',
    '        PreparedStatement statement = connection.prepareStatement(sql);',
    '        try {',
    '            bind(statement, values);',
    '            return statement;',
    '        } catch (SQLException error) {',
    '            statement.close();',
    '            throw error;',
    '        }',
    '    }',
    '',
    '    private static void bind(PreparedStatement statement, Object[] values) throws SQLException {',
    '        for (int index = 0; index < values.length; index++) statement.setObject(index + 1, value(values[index]));',
    '    }',
    '',
    `    /** A value as the driver takes it. */`,
    '    private static Object value(Object value) {',
    ...valueLines(database).map((line) => `        ${line}`),
    '    }',
    ...readerLines,
    '}',
  ]
  return file(context.base, 'Sql', body, imports)
}

/** The entity of a table: a plain class with a property per column, null until it is set or read. */
function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new JavaImports(pkg)
  for (const column of info.columns) if (column.javaImport) imports.add(column.javaImport)
  const fields = info.columns.flatMap((column, index) => [
    index > 0 ? '' : null,
    column.column.comment && `    /** ${column.column.comment} */`,
    column.column.type.kind === 'unknown' && `    // TODO: "${column.column.type.sql}" has no Java type here; it is kept as its text`,
    column.column.type.kind === 'array' &&
      `    // TODO: "${column.column.type.sql}" is kept as its text${context.settings.database === 'postgresql' ? ' (an array literal of PostgreSQL)' : ' (JSON)'}`,
    `    private ${column.java} ${column.prop};`,
  ])
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
  const written = imports.write()
  const content = lines(
    `package ${pkg};`,
    '',
    written !== '' && [written, ''],
    `/** A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. The repositories read and write it with SQL; a property stays null until it is set or read. */`,
    `public class ${info.entity} {`,
    ...fields,
    ...accessors,
    '}',
    '',
  )
  return { path: javaPath(pkg, info.entity), content }
}

export const sqlDatabaseFiles = (context: Context) => [databaseFile(context), sqlFile(context)]
export { entityFile as sqlEntityFile }
