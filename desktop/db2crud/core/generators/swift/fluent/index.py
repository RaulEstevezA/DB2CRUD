"""* Swift + FluentKit 1, without Vapor (Strategy of orm.ts): entities and Fluent models, repositories that query them, a unit
of work over Fluent's transactions, and tests on a database Fluent's schema builder creates. Mirrors
web/src/core/generators/swift/fluent/index.ts."""

import re

from ....js import coalesce
from ..context import find_info, ind, shared_file, sw_file, uses_times
from ..support import default_url
from ..swift import imports, sw_string
from ..tests import NAMES
from .entities import entity_file, model_file
from .repository import fluent_body, pg_enum, to_entity_function

_VERSIONS = {
    "fluentKit": "1.57.0",
    "postgres": "2.14.1",
    "mysql": "4.8.0",
    "sqlite": "4.9.0",
    "nio": "2.105.0",
    "postgresNio": "1.33.3",
    "log": "1.17.2",
}

_PACKAGES = {
    "FluentPostgresDriver": {"name": "fluent-postgres-driver", "version": _VERSIONS["postgres"]},
    "FluentMySQLDriver": {"name": "fluent-mysql-driver", "version": _VERSIONS["mysql"]},
    "FluentSQLiteDriver": {"name": "fluent-sqlite-driver", "version": _VERSIONS["sqlite"]},
}

_DRIVERS = {
    "postgresql": {"module": "FluentPostgresDriver", "factory": lambda url: f".postgres(url: {url})", "throws": True},
    "mysql": {"module": "FluentMySQLDriver", "factory": lambda url: f".mysql(url: {url})", "throws": True},
    "mariadb": {"module": "FluentMySQLDriver", "factory": lambda url: f".mysql(url: {url})", "throws": True},
    "sqlite": {
        "module": "FluentSQLiteDriver",
        "factory": lambda url: (
            f'.sqlite(.init(storage: .file(path: {url}.hasPrefix("sqlite://") ? String({url}.dropFirst(9)) : {url})))'
        ),
        "throws": False,
    },
}


def _driver_of(context: dict):
    return _DRIVERS.get(context["settings"]["database"], _DRIVERS["postgresql"])


def _database_file(context: dict) -> dict:
    """AppDatabase: the database DATABASE_URL names, through Fluent."""
    driver = _driver_of(context)
    return sw_file(
        shared_file(context, "AppDatabase"),
        imports("FluentKit", driver["module"], "Foundation", "Logging", "NIOCore", "NIOPosix"),
        [
            "/// The database DATABASE_URL names, through Fluent. It never migrates: the database already exists.",
            "public final class AppDatabase: Sendable {",
            f"    public static let defaultURL = {sw_string(default_url(context))}",
            "",
            "    private let databases: Databases",
            "    /// What the repositories run their queries on.",
            "    public let database: any Database",
            "",
            "    /// The database at url (DATABASE_URL, or defaultURL, by default).",
            f'    public convenience init(url: String = ProcessInfo.processInfo.environment["DATABASE_URL"] ?? AppDatabase.defaultURL){(" throws" if driver["throws"] else "")} {{',
            f"        {('try ' if driver['throws'] else '')}self.init(configuration: {driver['factory']('url')})",
            "    }",
            "",
            "    /// The database a configuration of Fluent names.",
            "    public init(configuration: DatabaseConfigurationFactory) {",
            "        let databases = Databases(threadPool: .singleton, on: MultiThreadedEventLoopGroup.singleton)",
            '        databases.use(configuration, as: DatabaseID(string: "app"))',
            "        self.databases = databases",
            '        self.database = databases.database(logger: Logger(label: "app.database"), on: MultiThreadedEventLoopGroup.singleton.any())!',
            "    }",
            "",
            "    /// Closes the connections.",
            "    public func shutdown() async {",
            "        await databases.shutdownAsync()",
            "    }",
            "}",
        ],
    )


def _creation_order(tables: list) -> list:
    """The tables in the order they can be created: the rows they point to first."""
    order = []

    def visit(info: dict, path: dict):
        if info in order or info["name"] in path:
            return
        path.add(info["name"])
        for key in info["table"]["foreignKeys"]:
            parent = next((item for item in tables if item["name"] == key["references"]["table"]), None)
            if parent and parent != info:
                visit(parent, path)
        order.append(info)

    for info in tables:
        visit(info, set())
    return order


def _sql_quote(text: str):
    return "'" + re.sub(r"'", "''", text) + "'"


def _data_type(context: dict, column: dict) -> str:
    """The data type of a column in Fluent's schema builder, as the database has it."""
    database = context["settings"]["database"]
    type_ = column["type"]

    def raw(sql: str):
        return f".sql(unsafeRaw: {sw_string(sql)})"

    if type_["kind"] == "enum" and database != "sqlite":
        item = next((candidate for candidate in context["schema"]["enums"] if candidate["name"] == type_["name"]), None)
        if (item or {}).get("storage") == "native":
            return (
                raw(f'"{item["name"]}"')
                if database == "postgresql"
                else raw(f"ENUM({', '.join(_sql_quote(item) for item in item['values'])})")
            )
    if type_["kind"] == "integer":
        return ".int16" if type_["bits"] == 16 else (".int64" if type_["bits"] == 64 else ".int32")
    if type_["kind"] == "decimal":
        return raw(f"DECIMAL({coalesce(type_.get('precision'), 10)}, {coalesce(type_.get('scale'), 0)})")
    if type_["kind"] == "float":
        return ".float" if type_["bits"] == 32 else ".double"
    if type_["kind"] == "boolean":
        return ".bool"
    if type_["kind"] == "text":
        return (
            ".string"
            if type_.get("length") is None
            else raw(f"{('CHAR' if type_.get('fixed') else 'VARCHAR')}({type_.get('length')})")
        )
    if type_["kind"] == "enum":
        values = coalesce(
            (next((item for item in context["schema"]["enums"] if item["name"] == type_["name"]), None) or {}).get(
                "values"
            ),
            [],
        )
        return raw(f"VARCHAR({max([1, *[len(value) for value in values]])})")
    if type_["kind"] == "date":
        return ".date"
    if type_["kind"] == "time":
        return ".time"
    if type_["kind"] == "datetime":
        return raw("TIMESTAMPTZ") if type_["timezone"] and database == "postgresql" else ".datetime"
    if type_["kind"] == "uuid":
        return ".uuid"
    if type_["kind"] == "binary":
        return ".data"
    return ".string"


def _constraints(context: dict, info: dict, column: dict) -> list[str]:
    """The constraints of a column in Fluent's schema builder: its key, null, its default."""
    db = column["column"]
    result = []
    single = len(info["table"]["primaryKey"] or []) == 1 and info["table"]["primaryKey"][0] == db["name"]
    if single:
        result.append(f".identifier(auto: {('true' if db.get('generated') == 'identity' else 'false')})")
    elif not db["nullable"]:
        result.append(".required")

    def raw(sql: str):
        return result.append(f".sql(unsafeRaw: {sw_string(sql)})")

    if db.get("generated") == "now" or db.get("generated") == "onUpdateNow":
        # Fluent writes a datetime as DATETIME(6) on MySQL, whose default must have the same precision
        raw(
            "DEFAULT CURRENT_DATE"
            if db["type"]["kind"] == "date"
            else (
                "DEFAULT CURRENT_TIMESTAMP(6)"
                if context["settings"]["database"] in ["mysql", "mariadb"] and _data_type(context, db) == ".datetime"
                else "DEFAULT CURRENT_TIMESTAMP"
            )
        )
    elif isinstance(db.get("generated"), dict):
        raw(f"GENERATED ALWAYS AS ({db.get('generated')['computed']}) STORED")
    elif (db.get("default") or {}).get("kind") == "literal" and db.get("default")["value"] is not None:
        value = db.get("default")["value"]
        raw(
            f"DEFAULT {(_sql_quote(value) if isinstance(value, str) else (('TRUE' if value else 'FALSE') if isinstance(value, bool) else str(value)))}"
        )
    elif (db.get("default") or {}).get("kind") == "expression":
        raw(f"DEFAULT {db.get('default')['sql']}")
    return result


_ACTIONS = {
    "cascade": ".cascade",
    "set null": ".setNull",
    "set default": ".setDefault",
    "restrict": ".restrict",
    "no action": ".noAction",
}


def _fields(names: list[str]):
    """The columns of a foreign key in Fluent's schema builder: a name, or a list of them."""
    return f"[{', '.join(sw_string(item) for item in names)}]" if len(names) > 1 else sw_string(names[0])


def _create_table(context: dict, info: dict) -> list[str]:
    """The schema builder of a table, as the database has it."""
    table = info["table"]
    space = (
        f", space: {sw_string(table.get('schema'))}"
        if table.get("schema") and context["settings"]["database"] == "postgresql"
        else ""
    )
    lines = [f"try await db.schema({sw_string(table['name'])}{space})"]
    for column in info["columns"]:
        lines.append(
            f"    .field({', '.join([sw_string(column['column']['name']), _data_type(context, column['column']), *_constraints(context, info, column)])})"
        )
    if table["primaryKey"] and len(table["primaryKey"]) > 1:
        lines.append(f"    .compositeIdentifier(over: {', '.join(sw_string(item) for item in table['primaryKey'])})")
    for unique in table["uniques"]:
        lines.append(
            f"    .unique(on: {', '.join(sw_string(item) for item in unique['columns'])}"
            + (f", name: {sw_string(unique.get('name'))}" if unique.get("name") else "")
            + ")"
        )
    for key in table["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if not parent or not parent["writesEntity"]:
            continue
        parent_space = (
            f", inSpace: {sw_string(parent['table'].get('schema'))}"
            if parent["table"].get("schema") and context["settings"]["database"] == "postgresql"
            else ""
        )
        lines.append(
            f"    .foreignKey({_fields(key['columns'])}, references: {sw_string(parent['name'])}{parent_space}, {_fields(key['references']['columns'])}, onDelete: {_ACTIONS.get(coalesce(key.get('onDelete'), 'no action'))}"
            + (f", name: {sw_string(key.get('name'))}" if key.get("name") else "")
            + ")"
        )
    lines.append("    .create()")
    return lines


def _test_database(context: dict):
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    postgres = database == "postgresql"
    tables = [info for info in context["tables"] if info["writesEntity"]]

    def quote(name: str):
        return f"`{name}`" if database == "mysql" or database == "mariadb" else f'"{name}"'

    def qualified_name(info: dict):
        return (
            f"{quote(info['table'].get('schema'))}.{quote(info['name'])}"
            if info["table"].get("schema") and postgres
            else quote(info["name"])
        )

    schemas = (
        list(
            dict.fromkeys(name for name in [info["table"].get("schema") for info in context["tables"]] if not not name)
        )
        if postgres
        else []
    )
    enums = (
        [
            item
            for item in context["schema"]["enums"]
            if item.get("storage") == "native"
            and any(
                any(
                    column["column"]["type"]["kind"] == "enum" and column["column"]["type"]["name"] == item["name"]
                    for column in info["columns"]
                )
                for info in context["tables"]
            )
        ]
        if postgres
        else []
    )

    def run(sql: str):
        return f"try await sql.raw({sw_string(sql)}).run()"

    order = _creation_order(tables)
    check = (
        "SELECT current_database() AS value"
        if postgres
        else ("SELECT sqlite_version() AS value" if sqlite else "SELECT DATABASE() AS value")
    )
    open = [
        *(
            [
                '        let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"]',
                "        let app = if let url { AppDatabase(url: url) } else { AppDatabase(configuration: .sqlite(.memory)) }",
            ]
            if sqlite
            else [
                "        // The tables are written for one kind of database: the tests cannot fall back to SQLite",
                (
                    '        let url = try #require(ProcessInfo.processInfo.environment["TEST_DATABASE_URL"], '
                    + sw_string(
                        f"The database tests need a disposable {NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
                    )
                    + ")"
                ),
                "        let app = try AppDatabase(url: url)",
            ]
        )
    ]
    recreate = [
        "    /// Drops every table, the rows that point to others first, and creates them again as the database has them.",
        "    private static func recreate(_ db: any Database) async throws {",
        "        let sql = db as! any SQLDatabase",
        *(
            ind(
                [
                    *(run(f"DROP SCHEMA IF EXISTS {quote(name)} CASCADE") for name in schemas),
                    *(
                        run(f"DROP TABLE IF EXISTS {qualified_name(info)}{(' CASCADE' if postgres else '')}")
                        for info in list(reversed([*order]))
                    ),
                    *(
                        line
                        for item in enums
                        for line in [
                            run(f"DROP TYPE IF EXISTS {quote(item['name'])} CASCADE"),
                            run(
                                f"CREATE TYPE {quote(item['name'])} AS ENUM ({', '.join(_sql_quote(item) for item in item['values'])})"
                            ),
                        ]
                    ),
                    *(run(f"CREATE SCHEMA {quote(name)}") for name in schemas),
                    *(line for info in order for line in _create_table(context, info)),
                ],
                8,
            )
        ),
        "    }",
    ]
    return {
        "modules": ["FluentKit", "FluentSQL", *([_driver_of(context)["module"]] if sqlite else [])],
        "open": open,
        "recreate": recreate,
        "check": f"(uow.db as! any SQLDatabase).raw({sw_string(check)}).all()",
    }


def _packages(context: dict):
    driver = _driver_of(context)["module"]
    driver_package = _PACKAGES.get(driver)
    postgres_times = context["settings"]["database"] == "postgresql" and uses_times(context)

    def product(name: str, pkg: str):
        return f'.product(name: "{name}", package: "{pkg}")'

    urls = [
        f'.package(url: "https://github.com/vapor/fluent-kit.git", from: "{_VERSIONS["fluentKit"]}"),',
        f'.package(url: "https://github.com/vapor/{driver_package["name"]}.git", from: "{driver_package["version"]}"),',
        f'.package(url: "https://github.com/apple/swift-nio.git", from: "{_VERSIONS["nio"]}"),',
        f'.package(url: "https://github.com/apple/swift-log.git", from: "{_VERSIONS["log"]}"),',
        *(
            [f'.package(url: "https://github.com/vapor/postgres-nio.git", from: "{_VERSIONS["postgresNio"]}"),']
            if postgres_times
            else []
        ),
    ]
    products = [
        product("FluentKit", "fluent-kit"),
        product("FluentSQL", "fluent-kit"),
        product(driver, driver_package["name"]),
        product("NIOCore", "swift-nio"),
        product("NIOPosix", "swift-nio"),
        product("Logging", "swift-log"),
        *([product("PostgresNIO", "postgres-nio")] if postgres_times else []),
    ]
    test_products = [
        product("FluentKit", "fluent-kit"),
        product("FluentSQL", "fluent-kit"),
        product(driver, driver_package["name"]),
    ]
    return {"packages": urls, "products": products, "testProducts": test_products}


FLUENT_ORM = {
    "id": "fluent",
    "label": "Fluent",
    "holder": {"type": "any Database", "optional": "(any Database)?", "modules": ["FluentKit"]},
    "emptyList": lambda *_: '"[]"',
    "databaseFile": _database_file,
    "entityFiles": lambda context, info: [entity_file(context, info), model_file(context, info)],
    "repository": {
        "modules": lambda context, info: [
            "FluentKit",
            *(["FluentSQL"] if any(pg_enum(context, column) for column in info["columns"]) else []),
        ],
        "body": fluent_body,
        "refusal": "let error as any DatabaseError where error.isConstraintFailure",
        "functions": lambda _context, info: to_entity_function(info),
    },
    "transaction": "try await db.transaction { transaction in try await work(SqlUnitOfWork(db: transaction)) }",
    "testDatabase": _test_database,
    "packages": _packages,
    "readme": {
        "intro": f"entities and Fluent {_VERSIONS['fluentKit']} models, repositories and services",
        "entities": "one entity and one Fluent model per table",
        "table": "entity, model, repositories and service of each table",
    },
}
