"""The database layer of a Java project without an ORM: Database, the JDBC connection to DATABASE_URL; Sql, what the
repositories run their SQL with (statements and their values as each driver takes them, rows read by the type of each
column, and the database's refusals); and the entities, plain classes with a property per column. Mirrors
web/src/core/generators/java/sql/database.ts."""

from ...types import lines
from ..context import package_of
from ..java import JavaImports, java_path, java_string
from ..support import file

_URLS = {
    "postgresql": "jdbc:postgresql://localhost:5432/app",
    "mysql": "jdbc:mysql://localhost:3306/app",
    "mariadb": "jdbc:mariadb://localhost:3306/app",
    "sqlite": "jdbc:sqlite:app.db?foreign_keys=true",
}


def _is_mysql(database: str) -> bool:
    return database in ("mysql", "mariadb")


def _database_file(context: dict) -> dict:
    """Database: the JDBC connection to the database DATABASE_URL names."""
    postgres = context["settings"]["database"] == "postgresql"
    url = java_string(_URLS.get(context["settings"]["database"], _URLS["postgresql"]))
    return file(
        context["base"],
        "Database",
        [
            "/** The database DATABASE_URL names (a JDBC URL; DATABASE_USER and DATABASE_PASSWORD), through its JDBC driver. */",
            "public final class Database {",
            f"    public static final String DEFAULT_URL = {url};",
            "",
            "    private Database() {}",
            "",
            "    /** A connection to the database at url; in production, take connections from a pool such as HikariCP. */",
            "    public static Connection connect(String url, String user, String password) {",
            "        Properties properties = new Properties();",
            '        if (user != null) properties.setProperty("user", user);',
            '        if (password != null) properties.setProperty("password", password);',
            *(
                [
                    "        // Texts are sent without a type, so PostgreSQL reads each one as its column has it: an enum, JSON",
                    '        properties.setProperty("stringtype", "unspecified");',
                ]
                if postgres
                else []
            ),
            "        try {",
            "            return DriverManager.getConnection(url, properties);",
            "        } catch (SQLException error) {",
            "            throw new Sql.DatabaseException(error);",
            "        }",
            "    }",
            "",
            "    /** A connection to DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD. */",
            "    public static Connection open() {",
            '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
            '        return connect(url, System.getenv("DATABASE_USER"), System.getenv("DATABASE_PASSWORD"));',
            "    }",
            "}",
        ],
        JavaImports(context["base"]).add(
            "java.sql.Connection", "java.sql.DriverManager", "java.sql.SQLException", "java.util.Properties"
        ),
    )


def _primitive(java: str, getter: str, type_: str) -> dict:
    """A reader of a primitive JDBC getter, which gives 0 or false for NULL."""
    return {
        "name": f"get{java}",
        "java": java,
        "body": [f"{type_} value = row.{getter}(index);", "return row.wasNull() ? null : value;"],
        "imports": [],
    }


def _parsed(java: str, java_import: str, parse: str) -> dict:
    """A reader of a text the driver gives, parsed into the type."""
    return {
        "name": f"get{java}",
        "java": java,
        "body": ["String text = row.getString(index);", f"return text == null ? null : {parse};"],
        "imports": [java_import],
    }


def _object(java: str, java_import: str) -> dict:
    """A reader through the driver's own conversion to the type (JDBC 4.2)."""
    return {
        "name": f"get{java}",
        "java": java,
        "body": [f"return row.getObject(index, {java}.class);"],
        "imports": [java_import],
    }


def _reader_of(database: str, java: str) -> dict:
    """How each Java type of a column is read on each database."""
    sqlite = database == "sqlite"
    primitives = {
        "Long": ("getLong", "long"),
        "Integer": ("getInt", "int"),
        "Short": ("getShort", "short"),
        "Double": ("getDouble", "double"),
        "Float": ("getFloat", "float"),
        "Boolean": ("getBoolean", "boolean"),
    }
    if java in primitives:
        return _primitive(java, *primitives[java])
    if java == "byte[]":
        return {"name": "getBytes", "java": java, "body": ["return row.getBytes(index);"], "imports": []}
    if java == "BigDecimal":
        # SQLite keeps a decimal as a number: its scale is given back from the column's
        if sqlite:
            return {
                "name": "getBigDecimal",
                "java": java,
                "body": [
                    "String text = row.getString(index);",
                    "if (text == null) return null;",
                    "BigDecimal value = new BigDecimal(text);",
                    "return scale < 0 ? value : value.setScale(scale, RoundingMode.HALF_UP);",
                ],
                "imports": ["java.math.BigDecimal", "java.math.RoundingMode"],
            }
        return {
            "name": "getBigDecimal",
            "java": java,
            "body": ["return row.getBigDecimal(index);"],
            "imports": ["java.math.BigDecimal"],
        }
    if java == "UUID":
        if database == "postgresql":
            return _object("UUID", "java.util.UUID")
        return _parsed("UUID", "java.util.UUID", "UUID.fromString(text)")
    if java == "LocalDate":
        if sqlite:
            return _parsed("LocalDate", "java.time.LocalDate", "LocalDate.parse(text)")
        return _object("LocalDate", "java.time.LocalDate")
    if java == "LocalTime":
        if sqlite:
            return _parsed("LocalTime", "java.time.LocalTime", "LocalTime.parse(text)")
        return _object("LocalTime", "java.time.LocalTime")
    if java == "LocalDateTime":
        # SQLite's CURRENT_TIMESTAMP writes a space between the date and the time
        if sqlite:
            return _parsed("LocalDateTime", "java.time.LocalDateTime", "LocalDateTime.parse(text.replace(' ', 'T'))")
        return _object("LocalDateTime", "java.time.LocalDateTime")
    zoned = ["java.time.LocalDateTime", "java.time.OffsetDateTime", "java.time.ZoneOffset"]
    if java == "OffsetDateTime":
        if database == "postgresql":
            return _object("OffsetDateTime", "java.time.OffsetDateTime")
        # MySQL and MariaDB keep no zone: the times are in UTC
        if _is_mysql(database):
            return {
                "name": "getOffsetDateTime",
                "java": java,
                "body": [
                    "LocalDateTime value = row.getObject(index, LocalDateTime.class);",
                    "return value == null ? null : value.atOffset(ZoneOffset.UTC);",
                ],
                "imports": zoned,
            }
        return {
            "name": "getOffsetDateTime",
            "java": java,
            "body": [
                "String text = row.getString(index);",
                "if (text == null) return null;",
                "String iso = text.replace(' ', 'T');",
                "// A time without its zone (CURRENT_TIMESTAMP) is in UTC",
                'return iso.matches(".*(Z|[+-]\\\\d\\\\d:?\\\\d\\\\d)$") ? OffsetDateTime.parse(iso) : LocalDateTime.parse(iso).atOffset(ZoneOffset.UTC);',
            ],
            "imports": zoned,
        }
    if java == "OffsetTime":
        if database == "postgresql":
            return _object("OffsetTime", "java.time.OffsetTime")
        return {
            "name": "getOffsetTime",
            "java": java,
            "body": [
                "String text = row.getString(index);",
                "return text == null ? null : LocalTime.parse(text).atOffset(ZoneOffset.UTC);",
            ],
            "imports": ["java.time.LocalTime", "java.time.OffsetTime", "java.time.ZoneOffset"],
        }
    return {"name": "getString", "java": "String", "body": ["return row.getString(index);"], "imports": []}


def read_call(context: dict, column: dict, index: int) -> str:
    """The reader of a column in Sql, with its arguments after the row: its position, and the scale of a decimal on
    SQLite."""
    reader = _reader_of(context["settings"]["database"], column["java"])
    scale = ""
    if reader["name"] == "getBigDecimal" and context["settings"]["database"] == "sqlite":
        type_ = column["column"]["type"]
        scale = f", {type_['scale'] if type_['kind'] == 'decimal' and type_.get('scale') is not None else -1}"
    return f"Sql.{reader['name']}(row, {index}{scale})"


def _value_lines(database: str) -> list[str]:
    """How each driver takes the values of the entities: what it cannot take is turned into what the column keeps."""
    if database == "postgresql":
        return ["return value;"]
    if _is_mysql(database):
        return [
            "if (value instanceof UUID uuid) return uuid.toString();",
            "// MySQL and MariaDB keep no zone: the times are written in UTC",
            "if (value instanceof OffsetDateTime time) return time.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime();",
            "if (value instanceof OffsetTime time) return time.withOffsetSameInstant(ZoneOffset.UTC).toLocalTime();",
            "return value;",
        ]
    return [
        "// SQLite keeps dates, times and uuids as their text, and decimals as numbers",
        "if (value instanceof UUID || value instanceof TemporalAccessor) return value.toString();",
        "if (value instanceof BigDecimal decimal) return decimal.toPlainString();",
        "return value;",
    ]


def _refusal_lines(database: str) -> list[str]:
    """Whether the database refused a write, from the error of its driver."""
    if database == "postgresql":
        return [
            "// SQLSTATE class 23: integrity constraint violation",
            'return state != null && state.startsWith("23");',
        ]
    if _is_mysql(database):
        return [
            "// SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)",
            'return (state != null && state.startsWith("23")) || error.getErrorCode() == 3819 || error.getErrorCode() == 4025;',
        ]
    return ["// SQLITE_CONSTRAINT, whatever its extended code", "return (error.getErrorCode() & 0xff) == 19;"]


def _insert_lines(database: str) -> list[str]:
    """How an insert gives back the id the database gave the new row, on MySQL, MariaDB and SQLite (PostgreSQL uses
    RETURNING)."""
    if database == "sqlite":
        return [
            "    try (PreparedStatement statement = prepare(connection, sql, values)) {",
            "        statement.executeUpdate();",
            "    } catch (SQLException error) {",
            "        throw failure(error);",
            "    }",
            "    // The row id of the connection's last insert, which is the key of a table numbered by SQLite",
            '    return one(connection, "SELECT last_insert_rowid()", (row) -> row.getLong(1)).orElse(null);',
        ]
    return [
        "    try (PreparedStatement statement = connection.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) {",
        "        bind(statement, values);",
        "        statement.executeUpdate();",
        "        try (ResultSet keys = statement.getGeneratedKeys()) {",
        "            return keys.next() ? keys.getLong(1) : null;",
        "        }",
        "    } catch (SQLException error) {",
        "        throw failure(error);",
        "    }",
    ]


_ORDER = [
    "getLong",
    "getInteger",
    "getShort",
    "getDouble",
    "getFloat",
    "getBoolean",
    "getString",
    "getBigDecimal",
    "getBytes",
]


def _rank(name: str) -> int:
    return _ORDER.index(name) + 1 if name in _ORDER else len(_ORDER) + 1


def _sql_file(context: dict) -> dict:
    """Sql: what the repositories run their SQL with."""
    database = context["settings"]["database"]
    postgres = database == "postgresql"
    imports = JavaImports(context["base"]).add(
        "java.sql.Connection",
        "java.sql.PreparedStatement",
        "java.sql.ResultSet",
        "java.sql.SQLException",
        "java.util.ArrayList",
        "java.util.List",
        "java.util.Optional",
    )
    if not postgres:
        imports.add("java.sql.Statement")
    if _is_mysql(database):
        imports.add("java.util.UUID", "java.time.OffsetDateTime", "java.time.OffsetTime", "java.time.ZoneOffset")
    if database == "sqlite":
        imports.add("java.util.UUID", "java.time.temporal.TemporalAccessor", "java.math.BigDecimal")
    readers: dict[str, dict] = {}
    for info in context["tables"]:
        for column in info["columns"]:
            reader = _reader_of(database, column["java"])
            readers[reader["name"]] = reader
    reader_lines = []
    for reader in sorted(readers.values(), key=lambda item: (_rank(item["name"]), item["name"])):
        imports.add(*reader["imports"])
        scale = ", int scale" if reader["name"] == "getBigDecimal" and database == "sqlite" else ""
        reader_lines += [
            "",
            f"    /** The {reader['java']} at index of a row, or null. */",
            f"    public static {reader['java']} {reader['name']}(ResultSet row, int index{scale}) throws SQLException {{",
            *(f"        {line}" for line in reader["body"]),
            "    }",
        ]
    body = [
        "/** What the repositories run their SQL with, over JDBC: statements and their values, rows read into entities, and the database's refusals. */",
        "public final class Sql {",
        "    private Sql() {}",
        "",
        "    /** Reads a row of a result. */",
        "    @FunctionalInterface",
        "    public interface Reader<T> {",
        "        T read(ResultSet row) throws SQLException;",
        "    }",
        "",
        "    /** The database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
        "    public static final class RefusedException extends RuntimeException {",
        "        public RefusedException(SQLException cause) {",
        "            super(cause.getMessage(), cause);",
        "        }",
        "    }",
        "",
        "    /** Any other failure of the database. */",
        "    public static final class DatabaseException extends RuntimeException {",
        "        public DatabaseException(SQLException cause) {",
        "            super(cause.getMessage(), cause);",
        "        }",
        "    }",
        "",
        "    /** Every row of a query. */",
        "    public static <T> List<T> all(Connection connection, String sql, Reader<T> reader, Object... values) {",
        "        try (PreparedStatement statement = prepare(connection, sql, values); ResultSet rows = statement.executeQuery()) {",
        "            List<T> result = new ArrayList<>();",
        "            while (rows.next()) result.add(reader.read(rows));",
        "            return result;",
        "        } catch (SQLException error) {",
        "            throw failure(error);",
        "        }",
        "    }",
        "",
        "    /** The first row of a query, if there is one. */",
        "    public static <T> Optional<T> one(Connection connection, String sql, Reader<T> reader, Object... values) {",
        "        List<T> rows = all(connection, sql, reader, values);",
        "        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));",
        "    }",
        "",
        "    /** Runs a statement that reads nothing back. */",
        "    public static void run(Connection connection, String sql, Object... values) {",
        "        try (PreparedStatement statement = prepare(connection, sql, values)) {",
        "            statement.executeUpdate();",
        "        } catch (SQLException error) {",
        "            throw failure(error);",
        "        }",
        "    }",
        not postgres
        and [
            "",
            "    /** Runs an insert; the id the database gave the new row, when it numbers them. */",
            "    public static Long insert(Connection connection, String sql, Object... values) {",
            *(f"    {line}" for line in _insert_lines(database)),
            "    }",
        ],
        "",
        "    /** The error of the database, as a RefusedException when it refused a write. */",
        "    public static RuntimeException failure(SQLException error) {",
        "        return isRefusal(error) ? new RefusedException(error) : new DatabaseException(error);",
        "    }",
        "",
        "    private static boolean isRefusal(SQLException error) {",
        "        String state = error.getSQLState();",
        *(f"        {line}" for line in _refusal_lines(database)),
        "    }",
        "",
        "    private static PreparedStatement prepare(Connection connection, String sql, Object[] values) throws SQLException {",
        "        PreparedStatement statement = connection.prepareStatement(sql);",
        "        try {",
        "            bind(statement, values);",
        "            return statement;",
        "        } catch (SQLException error) {",
        "            statement.close();",
        "            throw error;",
        "        }",
        "    }",
        "",
        "    private static void bind(PreparedStatement statement, Object[] values) throws SQLException {",
        "        for (int index = 0; index < values.length; index++) statement.setObject(index + 1, value(values[index]));",
        "    }",
        "",
        "    /** A value as the driver takes it. */",
        "    private static Object value(Object value) {",
        *(f"        {line}" for line in _value_lines(database)),
        "    }",
        *reader_lines,
        "}",
    ]
    return file(context["base"], "Sql", body, imports)


def _entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a plain class with a property per column, null until it is set or read."""
    pkg = package_of(context, info, "entity")
    imports = JavaImports(pkg)
    for column in info["columns"]:
        if column["javaImport"]:
            imports.add(column["javaImport"])
    fields: list = []
    for index, column in enumerate(info["columns"]):
        db = column["column"]
        kind = db["type"]["kind"]
        array = " (an array literal of PostgreSQL)" if context["settings"]["database"] == "postgresql" else " (JSON)"
        fields += [
            "" if index > 0 else None,
            db.get("comment") and f"    /** {db['comment']} */",
            kind == "unknown" and f'    // TODO: "{db["type"]["sql"]}" has no Java type here; it is kept as its text',
            kind == "array" and f'    // TODO: "{db["type"]["sql"]}" is kept as its text{array}',
            f"    private {column['java']} {column['prop']};",
        ]
    accessors: list = []
    for column in info["columns"]:
        accessors += [
            "",
            f"    public {column['java']} {column['getter']}() {{",
            f"        return {column['prop']};",
            "    }",
            "",
            f"    public void {column['setter']}({column['java']} {column['prop']}) {{",
            f"        this.{column['prop']} = {column['prop']};",
            "    }",
        ]
    written = imports.write()
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    content = lines(
        f"package {pkg};",
        "",
        written != "" and [written, ""],
        f'/** A row of the "{info["name"]}" table{comment}. The repositories read and write it with SQL; a property stays null until it is set or read. */',
        f"public class {info['entity']} {{",
        *fields,
        *accessors,
        "}",
        "",
    )
    return {"path": java_path(pkg, info["entity"]), "content": content}


def sql_database_files(context: dict) -> list[dict]:
    return [_database_file(context), _sql_file(context)]


sql_entity_file = _entity_file
