/**
 * The database layer of a Kotlin project without an ORM: `AppDatabase`, the JDBC connection to DATABASE_URL; `Sql`, what the
 * repositories run their SQL with (statements and their values as each driver takes them, and the database's refusals); how
 * each column of a row is read; and the entities, plain classes with a property per column.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Dialect } from '../../../schema/types.ts'
import { ktFile, optionalType, packageOf, pathOf, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { KtImports, ktString } from '../kotlin.ts'
import { defaultUrl } from '../support.ts'

const isMysql = (database: Dialect) => database === 'mysql' || database === 'mariadb'

/** `AppDatabase`: the JDBC connection to the database DATABASE_URL names. */
function databaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  const database = context.settings.database
  const imports = new KtImports(pkg).add('java.sql.Connection', 'java.sql.DriverManager', 'java.util.Properties')
  const properties: string[] = []
  if (database === 'postgresql')
    properties.push(
      '        // Texts are sent without a type, so PostgreSQL reads each one as its column has it: an enum, JSON',
      '        properties.setProperty("stringtype", "unspecified")',
    )
  if (database === 'sqlite') properties.push('        properties.setProperty("foreign_keys", "true")')
  return ktFile(pathOf(pkg, 'AppDatabase'), pkg, imports.write(), [
    '/** The database DATABASE_URL names (a JDBC URL), through its JDBC driver. */',
    'object AppDatabase {',
    `    const val DEFAULT_URL = ${ktString(defaultUrl(context))}`,
    '',
    '    /** A connection to the database at url (DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD, by default); in production, take connections from a pool such as HikariCP. */',
    '    fun connect(',
    '        url: String = System.getenv("DATABASE_URL") ?: DEFAULT_URL,',
    '        user: String = System.getenv("DATABASE_USER") ?: "",',
    '        password: String = System.getenv("DATABASE_PASSWORD") ?: "",',
    '    ): Connection {',
    '        val properties = Properties()',
    '        if (user != "") properties.setProperty("user", user)',
    '        if (password != "") properties.setProperty("password", password)',
    ...properties,
    '        return DriverManager.getConnection(url, properties)',
    '    }',
    '}',
  ])
}

/** A column of a row, which may be null, as the property keeps it. */
export function readColumn(context: Context, column: ColumnInfo, index: number, imports: KtImports): string {
  const database = context.settings.database
  const sqlite = database === 'sqlite'
  const at = String(index)
  const text = `row.getString(${at})?.let`
  switch (column.kt) {
    case 'Long':
    case 'Int':
    case 'Short':
    case 'Double':
    case 'Float':
    case 'Boolean':
      // JDBC gives 0 or false for NULL
      return `row.get${column.kt}(${at}).takeUnless { row.wasNull() }`
    case 'ByteArray':
      return `row.getBytes(${at})`
    case 'BigDecimal': {
      if (!sqlite) return `row.getBigDecimal(${at})`
      // SQLite keeps a decimal as a number: its scale is given back from the column's
      imports.add('java.math.BigDecimal')
      const scale = column.column.type.kind === 'decimal' ? column.column.type.scale : undefined
      if (scale === undefined) return `${text} { BigDecimal(it) }`
      imports.add('java.math.RoundingMode')
      return `${text} { BigDecimal(it).setScale(${scale}, RoundingMode.HALF_UP) }`
    }
    case 'UUID':
      imports.add('java.util.UUID')
      return database === 'postgresql' ? `row.getObject(${at}, UUID::class.java)` : `${text} { UUID.fromString(it) }`
    case 'LocalDate':
      imports.add('java.time.LocalDate')
      return sqlite ? `${text} { LocalDate.parse(it) }` : `row.getObject(${at}, LocalDate::class.java)`
    case 'LocalTime':
      if (database === 'postgresql' && column.column.type.kind === 'time' && column.column.type.timezone) {
        imports.add('java.time.OffsetTime')
        return `row.getObject(${at}, OffsetTime::class.java)?.toLocalTime()`
      }
      imports.add('java.time.LocalTime')
      return sqlite ? `${text} { LocalTime.parse(it) }` : `row.getObject(${at}, LocalTime::class.java)`
    case 'LocalDateTime':
      imports.add('java.time.LocalDateTime')
      // SQLite's CURRENT_TIMESTAMP writes a space between the date and the time
      return sqlite ? `${text} { LocalDateTime.parse(it.replace(' ', 'T')) }` : `row.getObject(${at}, LocalDateTime::class.java)`
    case 'OffsetDateTime':
      if (database === 'postgresql') {
        imports.add('java.time.OffsetDateTime')
        return `row.getObject(${at}, OffsetDateTime::class.java)`
      }
      if (sqlite) return `${text} { Sql.offsetDateTime(it) }`
      imports.add('java.time.LocalDateTime', 'java.time.ZoneOffset')
      // MySQL keeps no zone: the times are in UTC
      return `row.getObject(${at}, LocalDateTime::class.java)?.atOffset(ZoneOffset.UTC)`
    case 'Instant':
      imports.add('java.time.LocalDateTime', 'java.time.ZoneOffset')
      return `row.getObject(${at}, LocalDateTime::class.java)?.toInstant(ZoneOffset.UTC)`
    default:
      return `row.getString(${at})`
  }
}

/** How each driver takes the values of the entities: what it cannot take is turned into what the column keeps. */
function valueLines(database: Dialect, imports: KtImports): string[] {
  if (database === 'postgresql') return ['    private fun value(value: Any?): Any? = value']
  imports.add('java.time.OffsetDateTime', 'java.time.ZoneOffset', 'java.util.UUID')
  const head = ['    private fun value(value: Any?): Any? =', '        when (value) {']
  if (isMysql(database)) {
    imports.add('java.time.Instant', 'java.time.LocalDateTime')
    return [
      ...head,
      '            is UUID -> value.toString()',
      `            // ${database === 'mysql' ? 'MySQL' : 'MariaDB'} keeps no zone: the times are written in UTC`,
      '            is OffsetDateTime -> value.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime()',
      '            is Instant -> LocalDateTime.ofInstant(value, ZoneOffset.UTC)',
      '            else -> value',
      '        }',
    ]
  }
  imports.add('java.math.BigDecimal', 'java.time.temporal.TemporalAccessor')
  return [
    ...head,
    '            // SQLite keeps dates, times and uuids as their text (times with a zone, in UTC), and decimals as numbers',
    '            is OffsetDateTime -> value.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime().toString()',
    '            is UUID, is TemporalAccessor -> value.toString()',
    '            is BigDecimal -> value.toPlainString()',
    '            else -> value',
    '        }',
  ]
}

/** Whether the database refused a write, from the error of its driver. */
function refusalLines(database: Dialect): string[] {
  const state = 'error.sqlState?.startsWith("23") == true'
  if (database === 'postgresql')
    return [
      '    // SQLSTATE class 23: integrity constraint violation',
      `    private fun isRefusal(error: SQLException): Boolean = ${state}`,
    ]
  if (isMysql(database))
    return [
      '    // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)',
      `    private fun isRefusal(error: SQLException): Boolean = ${state} || error.errorCode == 3819 || error.errorCode == 4025`,
    ]
  return [
    '    // SQLITE_CONSTRAINT, whatever its extended code',
    '    private fun isRefusal(error: SQLException): Boolean = (error.errorCode and 0xff) == 19',
  ]
}

/** How an insert gives back the id the database gave the new row (PostgreSQL uses RETURNING). */
function insertLines(database: Dialect): string[] {
  const head = [
    '',
    '    /** Runs an insert; the id the database gave the new row, when it numbers them. */',
    '    fun insert(connection: Connection, sql: String, vararg values: Any?): Long? {',
  ]
  if (database === 'sqlite')
    return [
      ...head,
      '        run(connection, sql, *values)',
      "        // The row id of the connection's last insert, which is the key of a table numbered by SQLite",
      '        return one(connection, "SELECT last_insert_rowid()") { it.getLong(1) }',
      '    }',
    ]
  return [
    ...head,
    '        return execute({ connection.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS) }, values) { statement ->',
    '            statement.executeUpdate()',
    '            statement.generatedKeys.use { if (it.next()) it.getLong(1) else null }',
    '        }',
    '    }',
  ]
}

/** `Sql`: what the repositories run their SQL with. */
function sqlFile(context: Context): GeneratedFile {
  const pkg = context.base
  const database = context.settings.database
  const imports = new KtImports(pkg).add('java.sql.Connection', 'java.sql.PreparedStatement', 'java.sql.ResultSet', 'java.sql.SQLException')
  if (isMysql(database)) imports.add('java.sql.Statement')
  const value = valueLines(database, imports)
  const times = database === 'sqlite' && context.tables.some((info) => info.columns.some((column) => column.kt === 'OffsetDateTime'))
  if (times) imports.add('java.time.LocalDateTime')
  return ktFile(pathOf(pkg, 'Sql'), pkg, imports.write(), [
    '/** The database refused a write: a unique value taken, a row still pointed to, a value against its rules. */',
    'class RefusedException(cause: SQLException) : RuntimeException(cause.message, cause)',
    '',
    "/** What the repositories run their SQL with, over JDBC: statements and their values, and the database's refusals. */",
    'object Sql {',
    '    /** Every row of a query. */',
    '    fun <T> all(connection: Connection, sql: String, vararg values: Any?, read: (ResultSet) -> T): List<T> =',
    '        execute({ connection.prepareStatement(sql) }, values) { statement ->',
    '            statement.executeQuery().use { rows -> buildList { while (rows.next()) add(read(rows)) } }',
    '        }',
    '',
    '    /** The first row of a query, or null. */',
    '    fun <T : Any> one(connection: Connection, sql: String, vararg values: Any?, read: (ResultSet) -> T): T? =',
    '        all(connection, sql, *values, read = read).firstOrNull()',
    '',
    '    /** Runs a statement that reads nothing back. */',
    '    fun run(connection: Connection, sql: String, vararg values: Any?) {',
    '        execute({ connection.prepareStatement(sql) }, values) { it.executeUpdate() }',
    '    }',
    ...(database === 'postgresql' ? [] : insertLines(database)),
    '',
    ...(times
      ? [
          '    /** A time kept as text; one without its zone (CURRENT_TIMESTAMP) is in UTC. */',
          '    fun offsetDateTime(text: String): OffsetDateTime {',
          "        val iso = text.replace(' ', 'T')",
          '        val zoned = iso.endsWith("Z") || iso.substringAfter("T").any { it == \'+\' || it == \'-\' }',
          '        return if (zoned) OffsetDateTime.parse(iso) else LocalDateTime.parse(iso).atOffset(ZoneOffset.UTC)',
          '    }',
          '',
        ]
      : []),
    '    private fun <T> execute(prepare: () -> PreparedStatement, values: Array<out Any?>, work: (PreparedStatement) -> T): T =',
    '        try {',
    '            prepare().use { statement ->',
    '                values.forEachIndexed { index, value -> statement.setObject(index + 1, value(value)) }',
    '                work(statement)',
    '            }',
    '        } catch (error: SQLException) {',
    '            throw if (isRefusal(error)) RefusedException(error) else error',
    '        }',
    '',
    '    /** A value as the driver takes it. */',
    ...value,
    '',
    ...refusalLines(database),
    '}',
  ])
}

/** The entity of a table: a class with a property per column, null until it is set or read. */
function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new KtImports(pkg)
  for (const column of info.columns) if (column.ktImport) imports.add(column.ktImport)
  const kept = context.settings.database === 'postgresql' ? ' (an array literal of PostgreSQL)' : ' (JSON)'
  const properties = info.columns.flatMap((column) => [
    ...(column.column.type.kind === 'unknown'
      ? [`    // TODO: "${column.column.type.sql}" has no Kotlin type here; it is kept as its text`]
      : []),
    ...(column.column.type.kind === 'array' ? [`    // TODO: "${column.column.type.sql}" is kept as its text${kept}`] : []),
    `    var ${column.prop}: ${optionalType(column)} = null,`,
  ])
  return ktFile(pathOf(pkg, info.entity), pkg, imports.write(), [
    `/** A row of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}. The repositories read and write it with SQL; a property stays null until it is set or read. */`,
    `class ${info.entity}(`,
    ...properties,
    ')',
  ])
}

export const sqlDatabaseFiles = (context: Context) => [databaseFile(context), sqlFile(context)]
export const sqlEntityFiles = (context: Context, info: TableInfo) => [entityFile(context, info)]
