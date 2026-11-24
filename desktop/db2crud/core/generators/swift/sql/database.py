"""* The database layer of a Swift project without an ORM: AppDatabase.swift, with the pool of connections to DATABASE_URL, Db
(what the repositories run their SQL on: the pool, or the connection of a transaction) and the helpers they use; how each
column is selected, read and written; and the entities, plain structs with a property per column. Mirrors
web/src/core/generators/swift/sql/database.ts."""

from ....schema.ddl import quote_name, type_sql
from ..context import file_of, shared_file, sw_file
from ..support import MYSQL_DATA, default_url, uses_mysql_data
from ..swift import imports, sw_string


def _is_mysql(database: str):
    return database == "mysql" or database == "mariadb"


# Around the Swift code inside the text of a statement, until it is written as an interpolation.
_MARK = "\u0001"


def code(text: str):
    """Swift code inside a statement: bind: id."""
    return f"{_MARK}{text}{_MARK}"


def statement(sql: str) -> str:
    """The Swift literal of a statement, with its code as interpolations."""
    parts = [
        (f"\\({part})" if index % 2 == 1 else sw_string(part)[1:-1]) for index, part in enumerate(sql.split(_MARK))
    ]
    return f'"{"".join(parts)}"'


def driver_of(context: dict) -> dict:
    """The driver of each database: its module, its connections and its configuration."""
    database = context["settings"]["database"]
    if database == "sqlite":
        return {
            "module": "SQLiteKit",
            "source": "SQLiteConnectionSource",
            "configuration": "SQLiteConfiguration",
            "argument": "configuration",
        }
    if _is_mysql(database):
        return {
            "module": "MySQLKit",
            "source": "MySQLConnectionSource",
            "configuration": "MySQLConfiguration",
            "argument": "configuration",
        }
    return {
        "module": "PostgresKit",
        "source": "PostgresConnectionSource",
        "configuration": "SQLPostgresConfiguration",
        "argument": "sqlConfiguration",
    }


def _configuration_lines(database: str) -> list[str]:
    """How a URL becomes the configuration of the driver."""
    if database == "sqlite":
        return [
            '        self.init(configuration: SQLiteConfiguration(storage: .file(path: url.hasPrefix("sqlite://") ? String(url.dropFirst(9)) : url)))'
        ]
    if _is_mysql(database):
        return [
            "        guard let configuration = MySQLConfiguration(url: url) else { throw URLError(.badURL) }",
            "        self.init(configuration: configuration)",
        ]
    return ["        try self.init(configuration: SQLPostgresConfiguration(url: url))"]


def _transaction_lines(database: str) -> list[str]:
    """The transaction of Db: MySQL opens it outside its prepared statements."""
    signature = "    public func transaction<T: Sendable>(_ work: @escaping @Sendable (Db) async throws -> T) async throws -> T {"

    def ending(run):
        return [
            "            do {",
            "                let result = try await work(Db(sql: session, inTransaction: true))",
            f"                {run('COMMIT')}",
            "                return result",
            "            } catch {",
            f"                {run('ROLLBACK').replace('try await', 'try? await', 1)}",
            "                throw error",
            "            }",
        ]

    if _is_mysql(database):
        return [
            signature,
            "        guard let pool else { return try await work(self) }",
            "        return try await pool.withConnection(logger: sql.logger) { connection in",
            "            connection.eventLoop.makeFutureWithTask {",
            *(
                f"    {line}"
                for line in [
                    "            let session = connection.sql()",
                    '            _ = try await connection.simpleQuery("START TRANSACTION").get()',
                    *(ending(lambda sql: f'_ = try await connection.simpleQuery("{sql}").get()')),
                ]
            ),
            "            }",
            "        }.get()",
            "    }",
        ]
    return [
        signature,
        "        if inTransaction { return try await work(self) }",
        "        return try await sql.withSession { session in",
        '            try await session.raw("BEGIN").run()',
        *(ending(lambda sql: f'try await session.raw("{sql}").run()')),
        "        }",
        "    }",
    ]


def _refusal_lines(database: str) -> list[str]:
    """Whether the database refused a write, from the error of its driver."""
    head = [
        "/// Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules.",
        "func isRefusal(_ error: any Error) -> Bool {",
    ]
    if database == "postgresql":
        return [
            *head,
            "    // SQLSTATE class 23: integrity constraint violation",
            '    (error as? PSQLError)?.serverInfo?[.sqlState]?.hasPrefix("23") == true',
            "}",
        ]
    if _is_mysql(database):
        return [
            *head,
            "    switch error as? MySQLError {",
            "    case .duplicateEntry: true",
            "    // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)",
            '    case .server(let packet): packet.sqlState?.hasPrefix("23") == true || [3819, 4025].contains(packet.errorCode.rawValue)',
            "    default: false",
            "    }",
            "}",
        ]
    return [*head, '    (error as? SQLiteError).map { "\\($0.reason)".hasPrefix("constraint") } ?? false', "}"]


def _uses(context: dict, sw: str):
    """Whether a table of the project has a column of this type."""
    return any(any(column["sw"] == sw for column in info["columns"]) for info in context["tables"])


# SQLite keeps dates as their text, in UTC.
_DATES = [
    "",
    '/// A date as the text SQLite keeps, in UTC: "2026-01-31 12:00:00.000000", or only its day.',
    "func sqlText(_ date: Date, day: Bool = false) -> String {",
    "    let micros = Int64((date.timeIntervalSince1970 * 1_000_000).rounded())",
    "    let fraction = ((micros % 1_000_000) + 1_000_000) % 1_000_000",
    "    var calendar = Calendar(identifier: .gregorian)",
    "    calendar.timeZone = TimeZone(secondsFromGMT: 0)!",
    "    let parts = calendar.dateComponents(",
    "        [.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: Double((micros - fraction) / 1_000_000)))",
    '    let text = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)',
    '    return day ? text : text + String(format: " %02d:%02d:%02d.%06d", parts.hour!, parts.minute!, parts.second!, Int(fraction))',
    "}",
    "",
    "/// The date of a text SQLite keeps; one without its zone is in UTC, and a number is the seconds since 1970.",
    "func sqlDate(_ text: String) -> Date? {",
    "    if let seconds = Double(text) { return Date(timeIntervalSince1970: seconds) }",
    '    let halves = text.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "T" })',
    '    let days = halves[0].split(separator: "-").compactMap { Int($0) }',
    "    guard days.count == 3 else { return nil }",
    '    var time = halves.count > 1 ? String(halves[1]) : "00:00:00"',
    "    var offset = 0",
    '    if time.hasSuffix("Z") {',
    "        time.removeLast()",
    '    } else if let sign = time.lastIndex(where: { $0 == "+" || $0 == "-" }) {',
    "        let digits = time[time.index(after: sign)...].filter(\\.isNumber)",
    '        offset = ((Int(digits.prefix(2)) ?? 0) * 60 + (Int(digits.dropFirst(2)) ?? 0)) * (time[sign] == "-" ? -60 : 60)',
    "        time = String(time[..<sign])",
    "    }",
    '    let clock = time.split(separator: ":").compactMap { Double($0) }',
    "    guard clock.count >= 2 else { return nil }",
    "    var calendar = Calendar(identifier: .gregorian)",
    "    calendar.timeZone = TimeZone(secondsFromGMT: 0)!",
    "    guard let midnight = calendar.date(from: DateComponents(year: days[0], month: days[1], day: days[2])) else { return nil }",
    "    return midnight.addingTimeInterval((clock[0] * 60 + clock[1]) * 60 + (clock.count > 2 ? clock[2] : 0) - Double(offset))",
    "}",
]

# SQLiteKit has no database over a pool of its own.
_POOLED_SQLITE = [
    "/// SQLite through the connections of a pool.",
    "private struct PooledSQLite: SQLiteDatabase {",
    "    nonisolated(unsafe) let pool: EventLoopGroupConnectionPool<SQLiteConnectionSource>",
    "    let logger: Logger",
    "",
    "    var eventLoop: any EventLoop { pool.eventLoopGroup.any() }",
    "",
    "    func query(",
    "        _ query: String, _ binds: [SQLiteData], logger: Logger, _ onRow: @escaping @Sendable (SQLiteRow) -> Void",
    "    ) -> EventLoopFuture<Void> {",
    "        withConnection { $0.query(query, binds, logger: logger, onRow) }",
    "    }",
    "",
    "    func withConnection<T>(_ closure: @escaping @Sendable (SQLiteConnection) -> EventLoopFuture<T>) -> EventLoopFuture<T> {",
    "        pool.withConnection(logger: logger, closure)",
    "    }",
    "}",
    "",
]


def database_file(context: dict) -> dict:
    """AppDatabase.swift: the pool, Db, and the helpers of the repositories."""
    database = context["settings"]["database"]
    mysql = _is_mysql(database)
    driver = driver_of(context)
    throwing = "" if database == "sqlite" else " throws"
    inserts = mysql and any(any(item["kind"] == "insert" for item in info["queries"]) for info in context["tables"])
    return sw_file(
        shared_file(context, "AppDatabase"),
        imports(
            "AsyncKit",
            "Foundation",
            "Logging",
            "NIOPosix",
            "SQLKit",
            driver["module"],
            *(["NIOCore"] if database == "sqlite" or uses_mysql_data(context) else []),
        ),
        [
            f"/// The database DATABASE_URL names, through {driver['module']}. It never migrates: the database already exists.",
            "public final class AppDatabase: Sendable {",
            f"    public static let defaultURL = {sw_string(default_url(context))}",
            "",
            "    // The pool locks what it keeps, though AsyncKit does not declare it Sendable",
            f"    private nonisolated(unsafe) let pool: EventLoopGroupConnectionPool<{driver['source']}>",
            "    /// What the repositories run their SQL on.",
            "    public let database: Db",
            "",
            "    /// The database at url (DATABASE_URL, or defaultURL, by default).",
            f'    public convenience init(url: String = ProcessInfo.processInfo.environment["DATABASE_URL"] ?? AppDatabase.defaultURL){throwing} {{',
            *_configuration_lines(database),
            "    }",
            "",
            "    /// The database a configuration names.",
            f"    public init(configuration: {driver['configuration']}) {{",
            f"        let source = {driver['source']}({driver['argument']}: configuration)",
            "        let pool = EventLoopGroupConnectionPool(source: source, on: MultiThreadedEventLoopGroup.singleton)",
            "        self.pool = pool",
            (
                '        self.database = Db(sql: PooledSQLite(pool: pool, logger: Logger(label: "app.database")).sql())'
                if database == "sqlite"
                else f'        self.database = Db(sql: pool.database(logger: Logger(label: "app.database")).sql(){(", pool: pool" if mysql else "")})'
            ),
            "    }",
            "",
            "    /// Closes the connections.",
            "    public func shutdown() async {",
            "        try? await pool.shutdownAsync()",
            "    }",
            "}",
            "",
            *(_POOLED_SQLITE if database == "sqlite" else []),
            "/// What the repositories run their SQL on: the pool, or the connection of a transaction.",
            "public struct Db: Sendable {",
            "    public let sql: any SQLDatabase",
            *(
                [
                    "    /// Where transactions are opened; nil inside one.",
                    "    // The pool locks what it keeps, though AsyncKit does not declare it Sendable",
                    f"    private nonisolated(unsafe) let pool: EventLoopGroupConnectionPool<{driver['source']}>?",
                    "",
                    f"    init(sql: any SQLDatabase, pool: EventLoopGroupConnectionPool<{driver['source']}>? = nil, inTransaction: Bool = false) {{",
                    "        self.sql = sql",
                    "        self.pool = inTransaction ? nil : pool",
                    "    }",
                ]
                if mysql
                else [
                    "    private let inTransaction: Bool",
                    "",
                    "    init(sql: any SQLDatabase, inTransaction: Bool = false) {",
                    "        self.sql = sql",
                    "        self.inTransaction = inTransaction",
                    "    }",
                ]
            ),
            "",
            "    /// Runs work in a transaction, committed when it ends and undone when it throws; it joins the one already open.",
            *_transaction_lines(database),
            *(
                [
                    "",
                    "    /// Runs an insert; the id the database gave the new row, when it numbers them.",
                    "    func insert(_ query: SQLQueryString) async throws -> Int? {",
                    "        try await sql.withSession { session in",
                    "            try await session.raw(query).run()",
                    '            return try await session.raw("SELECT LAST_INSERT_ID() AS id").first()?.decode(column: "id", as: Int.self)',
                    "        }",
                    "    }",
                ]
                if inserts
                else []
            ),
            "}",
            "",
            "/// A value that may be nil, bound to a statement.",
            "func bound<T: Encodable & Sendable>(_ value: T?) -> any SQLExpression {",
            "    if let value { SQLBind(value) } else { SQLLiteral.null }",
            "}",
            "",
            "extension SQLRow {",
            "    /// The value of a column, or nil.",
            "    func optional<T: Decodable>(_ column: String, as type: T.Type) throws -> T? {",
            "        try decodeNil(column: column) ? nil : decode(column: column, as: type)",
            "    }",
            "}",
            "",
            *_refusal_lines(database),
            *(_DATES if database == "sqlite" and _uses(context, "Date") else []),
            *(MYSQL_DATA if uses_mysql_data(context) else []),
        ],
    )


# The kinds the drivers take and give as text only through a cast of PostgreSQL.
_AS_TEXT = set(["enum", "json", "array", "unknown"])


def selected(context: dict, column: dict) -> str:
    """ "status"::text AS "status": a column as a read selects it."""
    database = context["settings"]["database"]
    name = quote_name(database, column["column"]["name"])
    type_ = column["column"]["type"]
    if database == "postgresql":
        if type_["kind"] in _AS_TEXT:
            return f"{name}::text AS {name}"
        return f"{name}::time AS {name}" if type_["kind"] == "time" and type_["timezone"] else name
    if database == "sqlite":
        return f"CAST({name} AS TEXT) AS {name}" if column["sw"] in ["Decimal", "Date", "TimeOfDay"] else name
    return (
        f"CAST({name} AS CHAR) AS {name}"
        if type_["kind"] == "json" or type_["kind"] == "array" or column["sw"] == "TimeOfDay"
        else name
    )


def read_column(context: dict, column: dict) -> str:
    """A column of a row, as the property of the entity keeps it."""
    database = context["settings"]["database"]

    def read(type_: str):
        return f"try row.optional({sw_string(column['column']['name'])}, as: {type_}.self)"

    if column["sw"] == "UUID" and database != "postgresql":
        return f"{read('String')}.flatMap {{ UUID(uuidString: $0) }}"
    if column["sw"] == "Decimal" and database == "sqlite":
        return f"{read('String')}.flatMap {{ Decimal(string: $0) }}"
    if column["sw"] == "Date" and database == "sqlite":
        return f"{read('String')}.flatMap {{ sqlDate($0) }}"
    return read(column["sw"])


def _driver_value(context: dict, column: dict, value: str) -> str:
    """A value of the entity's type, as the driver takes it."""
    database = context["settings"]["database"]
    if database == "postgresql":
        return value
    if column["sw"] == "UUID":
        return f"{value}.uuidString.lowercased()"
    if column["sw"] == "TimeOfDay":
        return f"{value}.description"
    if database != "sqlite":
        return value
    if column["sw"] == "Decimal":
        return f'"\\({value})"'
    if column["sw"] == "Date":
        return f"sqlText({value}, day: true)" if column["column"]["type"]["kind"] == "date" else f"sqlText({value})"
    return value


def _typed(context: dict, column: dict, bind: str) -> str:
    """A bound value with what the database needs to take it as the type of the column."""
    type_ = column["column"]["type"]
    # The driver of MySQL sends the time too
    if _is_mysql(context["settings"]["database"]):
        return f"CAST({bind} AS DATE)" if type_["kind"] == "date" else bind
    if context["settings"]["database"] != "postgresql":
        return bind
    # The driver sends a point in time: a column without a zone keeps it in UTC
    if type_["kind"] == "date":
        return f"({bind}::timestamptz AT TIME ZONE 'UTC')::date"
    if type_["kind"] == "datetime":
        return bind if type_["timezone"] else f"({bind}::timestamptz AT TIME ZONE 'UTC')"
    if type_["kind"] == "enum":
        item = next((candidate for candidate in context["schema"]["enums"] if candidate["name"] == type_["name"]), None)
        return f"{bind}::{quote_name('postgresql', type_['name'])}" if (item or {}).get("storage") == "native" else bind
    return f"{bind}::{type_sql(context['schema'], 'postgresql', type_)}" if type_["kind"] in _AS_TEXT else bind


def bind_value(context: dict, column: dict, value: str):
    """A value that is not nil, inside a statement."""
    return _typed(context, column, code(f"bind: {_driver_value(context, column, value)}"))


def bind_optional(context: dict, column: dict, value: str) -> str:
    """A value that may be nil, inside a statement."""
    converted = _driver_value(context, column, "$0")
    return _typed(
        context, column, code(f"bound({value})" if converted == "$0" else f"bound({value}.map {{ {converted} }})")
    )


def entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a struct with a property per column, nil until it is set or read."""
    comment = f": {info['table'].get('comment')}" if info["table"].get("comment") else ""
    kept = " (an array literal of PostgreSQL)" if context["settings"]["database"] == "postgresql" else " (JSON)"
    properties = [
        line
        for column in info["columns"]
        for line in [
            *(
                [f'    // TODO: "{column["column"]["type"]["sql"]}" has no Swift type here; it is kept as its text']
                if column["column"]["type"]["kind"] == "unknown"
                else []
            ),
            *(
                [f'    // TODO: "{column["column"]["type"]["sql"]}" is kept as its text{kept}']
                if column["column"]["type"]["kind"] == "array"
                else []
            ),
            f"    public var {column['prop']}: {column['sw']}?",
        ]
    ]
    return sw_file(
        file_of(context, info, "entity", info["entity"]),
        imports("Foundation"),
        [
            f'/// A row of the "{info["name"]}" table{comment}. The repositories read and write it with SQL; a property stays nil until it is set or read.',
            f"public struct {info['entity']}: Sendable, Equatable {{",
            *properties,
            "",
            (
                "    public init("
                + ", ".join(f"{column['prop']}: {column['sw']}? = nil" for column in info["columns"])
                + ") {"
            ),
            *(f"        self.{column['prop']} = {column['prop']}" for column in info["columns"]),
            "    }",
            "}",
        ],
    )
