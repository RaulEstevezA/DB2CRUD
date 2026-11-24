"""* The database layer of a Kotlin project without an ORM: AppDatabase, the JDBC connection to DATABASE_URL; Sql, what the
repositories run their SQL with (statements and their values as each driver takes them, and the database's refusals); how
each column of a row is read; and the entities, plain classes with a property per column. Mirrors
web/src/core/generators/kotlin/sql/database.ts."""

from ..context import kt_file, optional_type, package_of, path_of
from ..kotlin import KtImports, kt_string
from ..support import default_url


def _is_mysql(database: str):
    return database == "mysql" or database == "mariadb"


def _database_file(context: dict) -> dict:
    """AppDatabase: the JDBC connection to the database DATABASE_URL names."""
    pkg = context["base"]
    database = context["settings"]["database"]
    imports = KtImports(pkg).add("java.sql.Connection", "java.sql.DriverManager", "java.util.Properties")
    properties = []
    if database == "postgresql":
        properties += [
            "        // Texts are sent without a type, so PostgreSQL reads each one as its column has it: an enum, JSON",
            '        properties.setProperty("stringtype", "unspecified")',
        ]
    if database == "sqlite":
        properties.append('        properties.setProperty("foreign_keys", "true")')
    return kt_file(
        path_of(pkg, "AppDatabase"),
        pkg,
        imports.write(),
        [
            "/** The database DATABASE_URL names (a JDBC URL), through its JDBC driver. */",
            "object AppDatabase {",
            f"    const val DEFAULT_URL = {kt_string(default_url(context))}",
            "",
            "    /** A connection to the database at url (DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD, by default); in production, take connections from a pool such as HikariCP. */",
            "    fun connect(",
            '        url: String = System.getenv("DATABASE_URL") ?: DEFAULT_URL,',
            '        user: String = System.getenv("DATABASE_USER") ?: "",',
            '        password: String = System.getenv("DATABASE_PASSWORD") ?: "",',
            "    ): Connection {",
            "        val properties = Properties()",
            '        if (user != "") properties.setProperty("user", user)',
            '        if (password != "") properties.setProperty("password", password)',
            *properties,
            "        return DriverManager.getConnection(url, properties)",
            "    }",
            "}",
        ],
    )


def read_column(context: dict, column: dict, index: int, imports: KtImports) -> str:
    """A column of a row, which may be null, as the property keeps it."""
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    at = str(index)
    text = f"row.getString({at})?.let"
    if column["kt"] in ("Long", "Int", "Short", "Double", "Float", "Boolean"):
        # JDBC gives 0 or false for NULL
        return f"row.get{column['kt']}({at}).takeUnless {{ row.wasNull() }}"
    if column["kt"] == "ByteArray":
        return f"row.getBytes({at})"
    if column["kt"] == "BigDecimal":
        if not sqlite:
            return f"row.getBigDecimal({at})"
        # SQLite keeps a decimal as a number: its scale is given back from the column's
        imports.add("java.math.BigDecimal")
        scale = column["column"]["type"].get("scale") if column["column"]["type"]["kind"] == "decimal" else None
        if scale is None:
            return f"{text} {{ BigDecimal(it) }}"
        imports.add("java.math.RoundingMode")
        return f"{text} {{ BigDecimal(it).setScale({scale}, RoundingMode.HALF_UP) }}"
    if column["kt"] == "UUID":
        imports.add("java.util.UUID")
        return (
            f"row.getObject({at}, UUID::class.java)"
            if database == "postgresql"
            else f"{text} {{ UUID.fromString(it) }}"
        )
    if column["kt"] == "LocalDate":
        imports.add("java.time.LocalDate")
        return f"{text} {{ LocalDate.parse(it) }}" if sqlite else f"row.getObject({at}, LocalDate::class.java)"
    if column["kt"] == "LocalTime":
        if (
            database == "postgresql"
            and column["column"]["type"]["kind"] == "time"
            and column["column"]["type"]["timezone"]
        ):
            imports.add("java.time.OffsetTime")
            return f"row.getObject({at}, OffsetTime::class.java)?.toLocalTime()"
        imports.add("java.time.LocalTime")
        return f"{text} {{ LocalTime.parse(it) }}" if sqlite else f"row.getObject({at}, LocalTime::class.java)"
    if column["kt"] == "LocalDateTime":
        imports.add("java.time.LocalDateTime")
        # SQLite's CURRENT_TIMESTAMP writes a space between the date and the time
        return (
            f"{text} {{ LocalDateTime.parse(it.replace(' ', 'T')) }}"
            if sqlite
            else f"row.getObject({at}, LocalDateTime::class.java)"
        )
    if column["kt"] == "OffsetDateTime":
        if database == "postgresql":
            imports.add("java.time.OffsetDateTime")
            return f"row.getObject({at}, OffsetDateTime::class.java)"
        if sqlite:
            return f"{text} {{ Sql.offsetDateTime(it) }}"
        imports.add("java.time.LocalDateTime", "java.time.ZoneOffset")
        # MySQL keeps no zone: the times are in UTC
        return f"row.getObject({at}, LocalDateTime::class.java)?.atOffset(ZoneOffset.UTC)"
    if column["kt"] == "Instant":
        imports.add("java.time.LocalDateTime", "java.time.ZoneOffset")
        return f"row.getObject({at}, LocalDateTime::class.java)?.toInstant(ZoneOffset.UTC)"
    return f"row.getString({at})"


def _value_lines(database: str, imports: KtImports) -> list[str]:
    """How each driver takes the values of the entities: what it cannot take is turned into what the column keeps."""
    if database == "postgresql":
        return ["    private fun value(value: Any?): Any? = value"]
    imports.add("java.time.OffsetDateTime", "java.time.ZoneOffset", "java.util.UUID")
    head = ["    private fun value(value: Any?): Any? =", "        when (value) {"]
    if _is_mysql(database):
        imports.add("java.time.Instant", "java.time.LocalDateTime")
        return [
            *head,
            "            is UUID -> value.toString()",
            f"            // {('MySQL' if database == 'mysql' else 'MariaDB')} keeps no zone: the times are written in UTC",
            "            is OffsetDateTime -> value.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime()",
            "            is Instant -> LocalDateTime.ofInstant(value, ZoneOffset.UTC)",
            "            else -> value",
            "        }",
        ]
    imports.add("java.math.BigDecimal", "java.time.temporal.TemporalAccessor")
    return [
        *head,
        "            // SQLite keeps dates, times and uuids as their text (times with a zone, in UTC), and decimals as numbers",
        "            is OffsetDateTime -> value.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime().toString()",
        "            is UUID, is TemporalAccessor -> value.toString()",
        "            is BigDecimal -> value.toPlainString()",
        "            else -> value",
        "        }",
    ]


def _refusal_lines(database: str) -> list[str]:
    """Whether the database refused a write, from the error of its driver."""
    state = 'error.sqlState?.startsWith("23") == true'
    if database == "postgresql":
        return [
            "    // SQLSTATE class 23: integrity constraint violation",
            f"    private fun isRefusal(error: SQLException): Boolean = {state}",
        ]
    if _is_mysql(database):
        return [
            "    // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)",
            f"    private fun isRefusal(error: SQLException): Boolean = {state} || error.errorCode == 3819 || error.errorCode == 4025",
        ]
    return [
        "    // SQLITE_CONSTRAINT, whatever its extended code",
        "    private fun isRefusal(error: SQLException): Boolean = (error.errorCode and 0xff) == 19",
    ]


def _insert_lines(database: str) -> list[str]:
    """How an insert gives back the id the database gave the new row (PostgreSQL uses RETURNING)."""
    head = [
        "",
        "    /** Runs an insert; the id the database gave the new row, when it numbers them. */",
        "    fun insert(connection: Connection, sql: String, vararg values: Any?): Long? {",
    ]
    if database == "sqlite":
        return [
            *head,
            "        run(connection, sql, *values)",
            "        // The row id of the connection's last insert, which is the key of a table numbered by SQLite",
            '        return one(connection, "SELECT last_insert_rowid()") { it.getLong(1) }',
            "    }",
        ]
    return [
        *head,
        "        return execute({ connection.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS) }, values) { statement ->",
        "            statement.executeUpdate()",
        "            statement.generatedKeys.use { if (it.next()) it.getLong(1) else null }",
        "        }",
        "    }",
    ]


def _sql_file(context: dict) -> dict:
    """Sql: what the repositories run their SQL with."""
    pkg = context["base"]
    database = context["settings"]["database"]
    imports = KtImports(pkg).add(
        "java.sql.Connection", "java.sql.PreparedStatement", "java.sql.ResultSet", "java.sql.SQLException"
    )
    if _is_mysql(database):
        imports.add("java.sql.Statement")
    value = _value_lines(database, imports)
    times = database == "sqlite" and any(
        any(column["kt"] == "OffsetDateTime" for column in info["columns"]) for info in context["tables"]
    )
    if times:
        imports.add("java.time.LocalDateTime")
    return kt_file(
        path_of(pkg, "Sql"),
        pkg,
        imports.write(),
        [
            "/** The database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
            "class RefusedException(cause: SQLException) : RuntimeException(cause.message, cause)",
            "",
            "/** What the repositories run their SQL with, over JDBC: statements and their values, and the database's refusals. */",
            "object Sql {",
            "    /** Every row of a query. */",
            "    fun <T> all(connection: Connection, sql: String, vararg values: Any?, read: (ResultSet) -> T): List<T> =",
            "        execute({ connection.prepareStatement(sql) }, values) { statement ->",
            "            statement.executeQuery().use { rows -> buildList { while (rows.next()) add(read(rows)) } }",
            "        }",
            "",
            "    /** The first row of a query, or null. */",
            "    fun <T : Any> one(connection: Connection, sql: String, vararg values: Any?, read: (ResultSet) -> T): T? =",
            "        all(connection, sql, *values, read = read).firstOrNull()",
            "",
            "    /** Runs a statement that reads nothing back. */",
            "    fun run(connection: Connection, sql: String, vararg values: Any?) {",
            "        execute({ connection.prepareStatement(sql) }, values) { it.executeUpdate() }",
            "    }",
            *([] if database == "postgresql" else _insert_lines(database)),
            "",
            *(
                [
                    "    /** A time kept as text; one without its zone (CURRENT_TIMESTAMP) is in UTC. */",
                    "    fun offsetDateTime(text: String): OffsetDateTime {",
                    "        val iso = text.replace(' ', 'T')",
                    "        val zoned = iso.endsWith(\"Z\") || iso.substringAfter(\"T\").any { it == '+' || it == '-' }",
                    "        return if (zoned) OffsetDateTime.parse(iso) else LocalDateTime.parse(iso).atOffset(ZoneOffset.UTC)",
                    "    }",
                    "",
                ]
                if times
                else []
            ),
            "    private fun <T> execute(prepare: () -> PreparedStatement, values: Array<out Any?>, work: (PreparedStatement) -> T): T =",
            "        try {",
            "            prepare().use { statement ->",
            "                values.forEachIndexed { index, value -> statement.setObject(index + 1, value(value)) }",
            "                work(statement)",
            "            }",
            "        } catch (error: SQLException) {",
            "            throw if (isRefusal(error)) RefusedException(error) else error",
            "        }",
            "",
            "    /** A value as the driver takes it. */",
            *value,
            "",
            *_refusal_lines(database),
            "}",
        ],
    )


def _entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a class with a property per column, null until it is set or read."""
    pkg = package_of(context, info, "entity")
    imports = KtImports(pkg)
    for column in info["columns"]:
        if column["ktImport"]:
            imports.add(column["ktImport"])
    kept = " (an array literal of PostgreSQL)" if context["settings"]["database"] == "postgresql" else " (JSON)"
    properties = [
        line
        for column in info["columns"]
        for line in [
            *(
                [f'    // TODO: "{column["column"]["type"]["sql"]}" has no Kotlin type here; it is kept as its text']
                if column["column"]["type"]["kind"] == "unknown"
                else []
            ),
            *(
                [f'    // TODO: "{column["column"]["type"]["sql"]}" is kept as its text{kept}']
                if column["column"]["type"]["kind"] == "array"
                else []
            ),
            f"    var {column['prop']}: {optional_type(column)} = null,",
        ]
    ]
    return kt_file(
        path_of(pkg, info["entity"]),
        pkg,
        imports.write(),
        [
            (
                f'/** A row of the "{info["name"]}" table'
                + (f": {info['table'].get('comment')}" if info["table"].get("comment") else "")
                + ". The repositories read and write it with SQL; a property stays null until it is set or read. */"
            ),
            f"class {info['entity']}(",
            *properties,
            ")",
        ],
    )


def sql_database_files(context: dict):
    return [_database_file(context), _sql_file(context)]


def sql_entity_files(context: dict, info: dict):
    return [_entity_file(context, info)]
