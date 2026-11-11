"""Files of the Vapor project that do not belong to one resource: the entry point and the wiring of the app, the
error format and its middleware, JSON, the reading of request bodies with their rules, list queries, query strings,
the clock, the settings read from the environment, authentication and the database connection. Mirrors
web/src/core/generators/frameworks/vapor/common.ts.
"""

from ....openapi.build import GENERAL_ERROR_CODES
from ...common.references import referenced_resources
from ...common.text import file_text, lines
from ...languages.swift.swift import sw_doc, sw_header, sw_string
from . import swift_blocks
from .context import VaporContext, names

# Default database URL of each database, for a database on this computer
DATABASE_URLS = {
    "postgresql": "postgres://api:change-me@localhost:5432/api",
    "mysql": "mysql://api:change-me@localhost:3306/api",
    "mariadb": "mysql://api:change-me@localhost:3306/api",
    "sqlite": "sqlite://app.db",
}


def block(text: str) -> list[str]:
    """The lines of a block of Swift written as one text, without its first line break."""
    return (text[1:] if text.startswith("\n") else text).split("\n")


def _file(name: str, doc: str, imports: list[str], body: list) -> dict:
    return {"path": f"Sources/App/Common/{name}.swift", "content": file_text(lines(*sw_header(doc, imports), *body))}


def common_files(context: VaporContext) -> list[dict]:
    return [
        _file(
            "ApiError",
            'The error format of the API: {"error": {"code", "message", "details"}}, with the status of openapi.yaml.',
            ["Vapor"],
            [
                block(swift_blocks.API_ERROR),
                "",
                "    static func serverError() -> ApiError {",
                f'        ApiError(status: .internalServerError, code: {sw_string(GENERAL_ERROR_CODES[1])}, message: "Something went wrong on the server")',
                "    }",
                "}",
            ],
        ),
        _file(
            "ApiErrorMiddleware",
            "Every error leaves the API in its error format.",
            ["Fluent", "Vapor"] if context.fluent else ["Vapor"],
            [
                sw_doc(
                    "Turns every error into the error format of the API, and tells a wrong method from a missing route."
                ),
                "struct ApiErrorMiddleware: AsyncMiddleware {",
                "    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {",
                "        do {",
                "            return try await next.respond(to: request)",
                "        } catch let error as ApiError {",
                "            return errorResponse(error)",
                context.fluent
                and [
                    "        } catch let error as any DatabaseError where error.isConstraintFailure {",
                    "            // A key already used. The cause stays in the log",
                    '            request.logger.warning("Integrity error: \\(String(describing: error))")',
                    '            return errorResponse(.conflict("The change conflicts with the stored data"))',
                ],
                "        } catch let error as any AbortError where error.status == .notFound {",
                "            if acceptsOtherMethod(request) {",
                f'                return errorResponse(ApiError(status: .methodNotAllowed, code: {sw_string(GENERAL_ERROR_CODES[0])}, message: "This path does not accept this method"))',
                "            }",
                '            return errorResponse(ApiError(status: .notFound, code: "not_found", message: "No route matches this request"))',
                "        } catch let error as any AbortError where error.status.code < 500 {",
                '            return errorResponse(ApiError(status: error.status, code: "bad_request", message: error.reason))',
                "        } catch {",
                '            request.logger.error("Unexpected error: \\(String(describing: error))")',
                "            return errorResponse(.serverError())",
                "        }",
                "    }",
                block(swift_blocks.MIDDLEWARE_TAIL),
            ],
        ),
        _file(
            "JSON",
            "JSON values, the JSON coders of the API and JSON answers.",
            ["Foundation", "Vapor"],
            block(swift_blocks.JSON),
        ),
        _file(
            "Body",
            "Reading request bodies: a JSON object that meets the rules of its type, checked before it is read.",
            ["Foundation", "Vapor"],
            block(swift_blocks.BODY),
        ),
        _file("List", "What a list asks a repository for, and what it gets back.", [], block(swift_blocks.LIST)),
        _file(
            "Query",
            "Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400.",
            ["Foundation", "Vapor"],
            block(swift_blocks.QUERY),
        ),
        _file("ServerClock", "The time the server writes, in UTC.", ["Foundation"], block(swift_blocks.CLOCK)),
        _settings_file(context),
    ]


def _settings_file(context: VaporContext) -> dict:
    """Settings of the API, read from the environment; the tests build their own."""
    auth = context.settings["auth"]
    database = context.settings.get("database")
    empty = not context.fluent and auth == "none"
    fields = [
        context.fluent
        and [
            "    /// Connection URL of the database (DATABASE_URL)",
            f"    var databaseURL = {sw_string(DATABASE_URLS[database or 'postgresql'])}",
        ],
        auth == "apiKey"
        and ["    /// Accepted API keys (API_KEYS, separated by commas)", "    var apiKeys: [String] = []"],
        auth == "jwt"
        and [
            "    /// Secret that signs the tokens (JWT_SECRET); without it every token is rejected",
            '    var jwtSecret = ""',
            "    /// Expected audience and issuer of the tokens, when set",
            '    var jwtAudience = ""',
            '    var jwtIssuer = ""',
        ],
    ]
    reads = [
        context.fluent and '        if let value = read("DATABASE_URL") { settings.databaseURL = value }',
        auth == "apiKey"
        and '        settings.apiKeys = (read("API_KEYS") ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }',
        auth == "jwt"
        and [
            '        settings.jwtSecret = read("JWT_SECRET") ?? ""',
            '        settings.jwtAudience = read("JWT_AUDIENCE") ?? ""',
            '        settings.jwtIssuer = read("JWT_ISSUER") ?? ""',
        ],
    ]
    return _file(
        "Settings",
        "Settings of the API, read from the environment (see .env.example).",
        [] if empty else ["Foundation", "Vapor"],
        [
            sw_doc("Settings of the API. The tests build their own."),
            [
                "struct Settings: Sendable {",
                "    static func fromEnvironment() -> Settings {",
                "        Settings()",
                "    }",
                "}",
            ]
            if empty
            else [
                "struct Settings: Sendable {",
                fields,
                "",
                "    static func fromEnvironment() -> Settings {",
                "        let read = { (name: String) -> String? in Environment.get(name).flatMap { $0.isEmpty ? nil : $0 } }",
                "        var settings = Settings()",
                reads,
                "        return settings",
                "    }",
                "}",
            ],
        ],
    )


def security_file(context: VaporContext) -> dict | None:
    """Authentication: what a protected handler asks for."""
    auth = context.settings["auth"]
    if auth == "none":
        return None
    body = block(swift_blocks.API_KEY_SECURITY if auth == "apiKey" else swift_blocks.JWT_SECURITY)
    imports = ["JWT", "Vapor"] if auth == "jwt" else ["Vapor"]
    return {
        "path": "Sources/App/Security/Security.swift",
        "content": file_text(lines(*sw_header("Authentication of the protected endpoints.", imports), *body)),
    }


def database_file(context: VaporContext) -> dict | None:
    """The database: connection, migrations and the sort helper of the repositories."""
    if not context.fluent:
        return None
    database = context.settings.get("database") or "postgresql"
    mysql = database in ("mysql", "mariadb")
    imports = ["Fluent", "FluentSQL", "FluentSQLiteDriver", "Vapor"]
    if database == "postgresql":
        imports.append("FluentPostgresDriver")
    if mysql:
        imports.append("FluentMySQLDriver")
    migrations = ", ".join(f"{names(resource)['migration']}()" for resource in context.spec["resources"])
    if database == "sqlite":
        urls = "sqlite://<file>"
    elif mysql:
        urls = "mysql://… or sqlite://<file>"
    else:
        urls = "postgres://… or sqlite://<file>"
    content = lines(
        *sw_header("The database of the API: its connection and its tables, one per resource.", imports),
        sw_doc("A DATABASE_URL this API cannot use."),
        "struct DatabaseURLError: Error, CustomStringConvertible {",
        "    let description: String",
        "}",
        "",
        sw_doc(
            f"Connects to the database of DATABASE_URL ({urls}) and adds the migrations of\nevery table. The "
            "application runs them when it starts, while you develop; use your own for a real database."
        ),
        "func useDatabase(_ app: Application, url: String) throws {",
        '    if url.hasPrefix("sqlite://") {',
        '        app.databases.use(.sqlite(.file(String(url.dropFirst("sqlite://".count)))), as: .sqlite)',
        database == "postgresql"
        and [
            '    } else if url.hasPrefix("postgres://") || url.hasPrefix("postgresql://") {',
            "        try app.databases.use(.postgres(url: url), as: .psql)",
        ],
        mysql
        and [
            '    } else if url.hasPrefix("mysql://"), var configuration = MySQLConfiguration(url: url) {',
            "        // TLS without certificate checks, as most servers use their own certificate; set your CA for production",
            "        var tls = TLSConfiguration.makeClientConfiguration()",
            "        tls.certificateVerification = .none",
            "        configuration.tlsConfiguration = tls",
            "        app.databases.use(.mysql(configuration: configuration), as: .mysql)",
        ],
        "    } else {",
        '        throw DatabaseURLError(description: "DATABASE_URL is not a database this API uses: \\(url)")',
        "    }",
        f"    app.migrations.add({migrations})",
        "}",
        "",
        sw_doc("Sorts the rows without a value last, whatever the order."),
        "func nullsLast(_ column: String) -> DatabaseQuery.Sort {",
        "    .sql(SQLBinaryExpression(left: SQLColumn(column), op: SQLBinaryOperator.is, right: SQLLiteral.null))",
        "}",
    )
    return {"path": "Sources/App/Database/DatabaseSetup.swift", "content": file_text(content)}


def configure_file(context: VaporContext) -> dict:
    """configure.swift: wires errors, storage, services and routes."""
    repositories = []
    services = []
    controllers = []
    for resource in context.spec["resources"]:
        name = names(resource)
        if context.pending:
            implementation = f"{name['pendingRepository']}()"
        elif context.fluent:
            implementation = f"{name['fluentRepository']}(database: app.db)"
        else:
            implementation = f"{name['memory']}()"
        repositories.append(f"    let {name['one']}Repository: any {name['repository']} = {implementation}")
        needs = [
            f"{names(item)['one']}Repository: {names(item)['one']}Repository"
            for item in referenced_resources(context, resource)
        ]
        arguments = ", ".join([f"repository: {name['one']}Repository", *needs])
        services.append(f"    let {name['one']}Service = {name['service']}({arguments})")
        security = ", security: security" if context.security else ""
        controllers.append(
            f"    try app.register(collection: {name['controller']}(service: {name['one']}Service{security}))"
        )
    content = lines(
        *sw_header(
            "Wires the API: errors, storage, services and routes.", ["Fluent", "Vapor"] if context.fluent else ["Vapor"]
        ),
        sw_doc("Builds the API with its settings: the app that the entry point runs and the tests call."),
        "func configure(_ app: Application, settings: Settings) async throws {",
        '    app.routes.defaultMaxBodySize = "1mb"',
        "    // The error format of the API replaces Vapor's",
        "    app.middleware = Middlewares()",
        "    app.middleware.use(ApiErrorMiddleware())",
        context.fluent
        and [
            "    // Creates the tables that are missing, while you develop",
            "    try useDatabase(app, url: settings.databaseURL)",
            "    try await app.autoMigrate()",
        ],
        context.security and "    let security = await Security.make(settings)",
        "",
        repositories,
        services,
        controllers,
        "}",
    )
    return {"path": "Sources/App/configure.swift", "content": file_text(content)}


def entrypoint_file() -> dict:
    """entrypoint.swift: starts the API on PORT with the settings of the environment."""
    content = lines(
        *sw_header("Starts the API on PORT (8080 by default) with the settings of the environment.", ["Vapor"]),
        "@main",
        "enum Entrypoint {",
        "    static func main() async throws {",
        "        var environment = try Environment.detect()",
        "        try LoggingSystem.bootstrap(from: &environment)",
        "        let app = try await Application.make(environment)",
        '        app.http.server.configuration.hostname = "0.0.0.0"',
        '        app.http.server.configuration.port = Environment.get("PORT").flatMap(Int.init) ?? 8080',
        "        do {",
        "            try await configure(app, settings: .fromEnvironment())",
        "            try await app.execute()",
        "        } catch {",
        "            app.logger.report(error: error)",
        "            try? await app.asyncShutdown()",
        "            throw error",
        "        }",
        "        try await app.asyncShutdown()",
        "    }",
        "}",
    )
    return {"path": "Sources/App/entrypoint.swift", "content": file_text(content)}
