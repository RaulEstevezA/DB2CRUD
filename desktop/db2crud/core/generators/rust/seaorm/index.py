"""* Rust + SeaORM 2 (Strategy of orm.ts): entities and SeaORM descriptions of the tables, repositories that query them, a unit
of work over SeaORM's transactions, and tests on a database created from the descriptions. Mirrors
web/src/core/generators/rust/seaorm/index.ts."""

from ..context import module_of, rs_file
from ..rust import RsUses, rs_string
from ..support import default_url
from ..tests import TESTS, external, unit_of_work
from .entities import entity_file, native_enum, table_file
from .repository import sea_body, sea_helpers

_SEA_ORM = "2.0.4"

_DRIVERS = {"postgresql": "sqlx-postgres", "mysql": "sqlx-mysql", "mariadb": "sqlx-mysql", "sqlite": "sqlx-sqlite"}


def _database_file(context: dict) -> dict:
    """database.rs: the connection DATABASE_URL names, and Db, what repositories run their queries on."""
    return rs_file(
        "src/database.rs",
        "use sea_orm::{DatabaseConnection, DatabaseExecutor, DatabaseTransaction, DbErr};",
        [
            f"pub const DEFAULT_URL: &str = {rs_string(default_url(context))};",
            "",
            "/// A connection to the database at DATABASE_URL (DEFAULT_URL when it is not set).",
            "pub async fn connect() -> Result<DatabaseConnection, DbErr> {",
            '    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());',
            "    sea_orm::Database::connect(url).await",
            "}",
            "",
            "/// What repositories run their queries on: the connection, or a transaction opened on it.",
            "pub enum Db {",
            "    Connection(DatabaseConnection),",
            "    Transaction(DatabaseTransaction),",
            "}",
            "",
            "impl Db {",
            "    pub fn executor(&self) -> DatabaseExecutor<'_> {",
            "        match self {",
            "            Db::Connection(connection) => connection.into(),",
            "            Db::Transaction(transaction) => transaction.into(),",
            "        }",
            "    }",
            "}",
        ],
        ["The database DATABASE_URL names, through SeaORM. It never migrates: the database already exists."],
    )


_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


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


def _test_database_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    postgres = database == "postgresql"
    tables = [info for info in context["tables"] if info["writesEntity"]]
    uses = RsUses().add(
        "sea_orm::ConnectionTrait",
        "sea_orm::Database",
        "sea_orm::DatabaseConnection",
        "sea_orm::Schema",
        "sea_orm::Statement",
        "tokio::sync::Mutex",
        "tokio::sync::MutexGuard",
        f"{unit_of_work(context)}::SqlUnitOfWork",
    )
    if sqlite:
        uses.add("std::sync::atomic::AtomicUsize", "std::sync::atomic::Ordering")

    # Each table's module by a name of its own: by table, every one of them is `table`
    def table_module(info: dict):
        return f"{info['attr'].replace(r'^r#', '', 1)}_table"

    for info in tables:
        uses.add(f"{external(context, module_of(context, info, 'table'))} as {table_module(info)}")

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
            if any(
                any(native_enum(context, column["column"]) == item for column in info["columns"])
                for info in context["tables"]
            )
        ]
        if postgres
        else []
    )

    def sql_quote(text: str):
        return "'" + text.replace("'", "''") + "'"

    def run(sql: str):
        return f"    db.execute_unprepared({rs_string(sql)}).await.expect({rs_string(sql)});"

    order = _creation_order(tables)
    sql = "SELECT current_database()" if postgres else ("SELECT sqlite_version()" if sqlite else "SELECT DATABASE()")
    return {
        "path": f"{TESTS}/database.rs",
        "content": "\n".join(
            [
                (
                    "//! The test database: TEST_DATABASE_URL, or SQLite in a new temporary file, created from the SeaORM entities before every test."
                    if sqlite
                    else f"//! The test database: the {_NAMES.get(database)} database TEST_DATABASE_URL names, created from the SeaORM entities before every test."
                ),
                "",
                uses.write(),
                "",
                "/// Every test empties the same database: they take turns",
                "static TURN: Mutex<()> = Mutex::const_new(());",
                "",
                "/// A connection to the test database.",
                "async fn connect() -> DatabaseConnection {",
                *(
                    [
                        '    let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {',
                        "        // A new file for every test: SQLite in memory would be another database on every connection",
                        "        static FILES: AtomicUsize = AtomicUsize::new(0);",
                        (
                            "        let name = format!("
                            + rs_string(f"{context['crate']}-{{}}-{{}}.db")
                            + ", std::process::id(), FILES.fetch_add(1, Ordering::SeqCst));"
                        ),
                        '        format!("sqlite://{}?mode=rwc", std::env::temp_dir().join(name).display())',
                        "    });",
                    ]
                    if sqlite
                    else [
                        "    // The entities are written for one kind of database: the tests cannot fall back to SQLite",
                        (
                            '    let url = std::env::var("TEST_DATABASE_URL").expect('
                            + rs_string(
                                f"The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
                            )
                            + ");"
                        ),
                    ]
                ),
                '    Database::connect(&url).await.expect("the test database")',
                "}",
                "",
                "/// The repositories over the test database, with every table dropped and created again, and the turn of the test",
                "/// that holds it.",
                "pub async fn open() -> (MutexGuard<'static, ()>, SqlUnitOfWork) {",
                "    let turn = TURN.lock().await;",
                "    let db = connect().await;",
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
                            f"CREATE TYPE {quote(item['name'])} AS ENUM ({', '.join(sql_quote(item) for item in item['values'])})"
                        ),
                    ]
                ),
                *(run(f"CREATE SCHEMA {quote(name)}") for name in schemas),
                "    Schema::new(db.get_database_backend())",
                "        .builder()",
                *(f"        .register({table_module(info)}::Entity)" for info in tables),
                "        .apply(&db)",
                "        .await",
                '        .expect("the tables");',
                "    (turn, SqlUnitOfWork::new(db))",
                "}",
                "",
                "#[tokio::test]",
                ("async fn is_sqlite() {" if sqlite else "async fn is_the_one_test_database_url_names() {"),
                "    let _turn = TURN.lock().await;",
                "    let db = connect().await;",
                f'    let row = db.query_one_raw(Statement::from_string(db.get_database_backend(), {rs_string(sql)})).await.expect("a query").expect("a row");',
                '    let value: String = row.try_get_by_index(0).expect("a value");',
                (
                    '    assert!(value.starts_with("3."));'
                    if sqlite
                    else "    let url = std::env::var(\"TEST_DATABASE_URL\").expect(\"TEST_DATABASE_URL\");\n    assert_eq!(url.rsplit('/').next().and_then(|name| name.split('?').next()), Some(value.as_str()));"
                ),
                "}",
                "",
            ]
        ),
    }


def _dependencies(context: dict, used: dict) -> list[str]:
    features = [
        "macros",
        "runtime-tokio-rustls",
        _DRIVERS.get(context["settings"]["database"], _DRIVERS["postgresql"]),
        *(["with-chrono"] if "chrono" in used else []),
        *(["with-rust_decimal"] if "rust_decimal" in used else []),
        *(["with-uuid"] if "uuid" in used else []),
    ]
    return [
        (
            f'sea-orm = {{ version = "{_SEA_ORM}", default-features = false, features = ['
            + ", ".join(f'"{item}"' for item in features)
            + "] }"
        )
    ]


_UNIT = {
    "uses": ["sea_orm::DatabaseConnection", "sea_orm::DatabaseTransaction", "sea_orm::TransactionTrait"],
    "constructors": [
        "    /// The repositories over a connection: every write outside a transaction is committed at once.",
        "    pub fn new(connection: DatabaseConnection) -> Self {",
        "        Self { db: Db::Connection(connection) }",
        "    }",
        "",
        "    /// The repositories inside a transaction someone else opened; commit() commits it.",
        "    pub fn in_transaction(transaction: DatabaseTransaction) -> Self {",
        "        Self { db: Db::Transaction(transaction) }",
        "    }",
    ],
    "begin": [
        "        // Inside a transaction, a new one is a savepoint of it",
        "        let transaction = match &self.db {",
        "            Db::Connection(connection) => connection.begin().await?,",
        "            Db::Transaction(transaction) => transaction.begin().await?,",
        "        };",
        "        Ok(Box::new(SqlUnitOfWork::in_transaction(transaction)))",
    ],
    "commit": [
        "        if let Db::Transaction(transaction) = self.db {",
        "            transaction.commit().await?;",
        "        }",
        "        Ok(())",
    ],
}

SEAORM_ORM = {
    "id": "seaorm",
    "label": "SeaORM",
    "error": "sea_orm::DbErr",
    "emptyList": lambda context: (
        '"{}".to_string()' if context["settings"]["database"] == "postgresql" else '"[]".to_string()'
    ),
    "databaseFiles": lambda context: [_database_file(context)],
    "entityFiles": lambda context, info: [entity_file(context, info), table_file(context, info)],
    "repository": {
        "uses": lambda context, info: [f"{module_of(context, info, 'table')} as table"],
        "body": sea_body,
        "helpers": sea_helpers,
    },
    "unitOfWork": lambda *_: _UNIT,
    "testDatabaseFile": _test_database_file,
    "dependencies": _dependencies,
    "readme": {
        "intro": f"entities and SeaORM {_SEA_ORM} descriptions of the tables, repositories and services",
        "entities": "one entity and one SeaORM description per table",
        "table": "entity, SeaORM description, repositories and service of each table",
        "folder": "The entities of every table, and the SeaORM description of each table.",
    },
}
