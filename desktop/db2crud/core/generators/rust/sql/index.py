"""* Rust without an ORM (Strategy of orm.ts): repositories that write their SQL and run it through sqlx (sql/database.ts holds
the pool and the helpers), plain structs as entities, a unit of work over sqlx's transactions, and tests on a real database
created from the schema's DDL (SQLite in a temporary file, or the database TEST_DATABASE_URL names: the DDL is written for
one kind of database). Mirrors
web/src/core/generators/rust/sql/index.ts."""

from ....schema.ddl import create_statements, drop_statements
from ..rust import RsUses, rs_string
from ..tests import TESTS, external, unit_of_work
from .database import database_file, driver_types, entity_file
from .repository import sql_body, sql_helpers

_SQLX = "0.9.1"

_TOKIO = "1.54.1"

_NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    uses = RsUses().add(
        "sqlx::Row",
        "tokio::sync::Mutex",
        "tokio::sync::MutexGuard",
        f"{unit_of_work(context)}::SqlUnitOfWork",
        external(context, "crate::database::Pool"),
    )
    if sqlite:
        uses.add("std::sync::atomic::AtomicUsize", "std::sync::atomic::Ordering")

    def list_(name: str, doc: str, statements: list[str]):
        return [
            f"/// {doc}",
            f"const {name}: &[&str] = &[",
            *(f"    {rs_string(statement)}," for statement in statements),
            "];",
            "",
        ]

    sql = (
        "SELECT current_database()"
        if database == "postgresql"
        else ("SELECT sqlite_version()" if sqlite else "SELECT DATABASE()")
    )
    get = "try_get" if database == "postgresql" or sqlite else "try_get_unchecked"
    return {
        "path": f"{TESTS}/database.rs",
        "content": "\n".join(
            [
                (
                    "//! The test database: TEST_DATABASE_URL, or SQLite in a new temporary file, created from the schema before every test."
                    if sqlite
                    else f"//! The test database: the {_NAMES.get(database)} database TEST_DATABASE_URL names, created from the schema before every test."
                ),
                "",
                uses.write(),
                "",
                *(
                    list_(
                        "DROP",
                        "Removes every table, so the database starts empty.",
                        drop_statements(context["schema"], database),
                    )
                ),
                *(
                    list_(
                        "CREATE",
                        "Creates every table, in an order the database accepts.",
                        create_statements(context["schema"], database),
                    )
                ),
                "/// Every test empties the same database: they take turns",
                "static TURN: Mutex<()> = Mutex::const_new(());",
                "",
                "/// A pool of connections to the test database.",
                "async fn connect() -> Pool {",
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
                        "    // The tables are written for one kind of database: the tests cannot fall back to SQLite",
                        (
                            '    let url = std::env::var("TEST_DATABASE_URL").expect('
                            + rs_string(
                                f"The database tests need a disposable {_NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)"
                            )
                            + ");"
                        ),
                    ]
                ),
                '    Pool::connect(&url).await.expect("the test database")',
                "}",
                "",
                "/// The repositories over the test database, with every table dropped and created again, and the turn of the test",
                "/// that holds it.",
                "pub async fn open() -> (MutexGuard<'static, ()>, SqlUnitOfWork) {",
                "    let turn = TURN.lock().await;",
                "    let pool = connect().await;",
                "    // On one connection, as MySQL turns its foreign key checks off for the connection that asks",
                '    let mut connection = pool.acquire().await.expect("a connection");',
                "    for sql in DROP.iter().chain(CREATE) {",
                "        sqlx::raw_sql(*sql).execute(&mut *connection).await.expect(sql);",
                "    }",
                "    drop(connection);",
                "    (turn, SqlUnitOfWork::new(pool))",
                "}",
                "",
                "#[tokio::test]",
                ("async fn is_sqlite() {" if sqlite else "async fn is_the_one_test_database_url_names() {"),
                "    let _turn = TURN.lock().await;",
                f'    let row = sqlx::query({rs_string(sql)}).fetch_one(&connect().await).await.expect("a row");',
                f'    let value: String = row.{get}(0).expect("a value");',
                *(
                    ['    assert!(value.starts_with("3."));']
                    if sqlite
                    else [
                        '    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");',
                        "    assert_eq!(url.rsplit('/').next().and_then(|name| name.split('?').next()), Some(value.as_str()));",
                    ]
                ),
                "}",
                "",
            ]
        ),
    }


def _dependencies(context: dict, used: dict) -> list[str]:
    features = [
        "runtime-tokio",
        "tls-rustls",
        driver_types(context)["feature"],
        *(["chrono"] if "chrono" in used else []),
        *(["rust_decimal"] if "rust_decimal" in used and context["settings"]["database"] != "sqlite" else []),
        *(["uuid"] if "uuid" in used else []),
    ]
    return [
        (
            f'sqlx = {{ version = "{_SQLX}", default-features = false, features = ['
            + ", ".join(f'"{item}"' for item in features)
            + "] }"
        ),
        f'tokio = {{ version = "{_TOKIO}", features = ["sync"] }}',
    ]


_UNIT = {
    "uses": [
        "sqlx::Transaction",
        "std::sync::Arc",
        "tokio::sync::Mutex",
        "crate::database::Driver",
        "crate::database::Pool",
    ],
    "constructors": [
        "    /// The repositories over a pool: every write outside a transaction is committed at once.",
        "    pub fn new(pool: Pool) -> Self {",
        "        Self { db: Db::Pool(pool) }",
        "    }",
        "",
        "    /// The repositories inside a transaction someone else opened; commit() commits it.",
        "    pub fn in_transaction(transaction: Transaction<'static, Driver>) -> Self {",
        "        Self { db: Db::Transaction(Arc::new(Mutex::new(transaction))) }",
        "    }",
    ],
    "begin": [
        "        match &self.db {",
        "            Db::Pool(pool) => Ok(Box::new(SqlUnitOfWork::in_transaction(pool.begin().await?))),",
        "            // Joins the transaction already open: whoever opened it commits it",
        "            Db::Transaction(transaction) | Db::Joined(transaction) => {",
        "                Ok(Box::new(SqlUnitOfWork { db: Db::Joined(transaction.clone()) }))",
        "            }",
        "        }",
    ],
    "commit": [
        "        if let Db::Transaction(transaction) = self.db {",
        "            let transaction = Arc::into_inner(transaction)",
        '                .ok_or_else(|| sqlx::Error::Protocol("a unit of work that joined the transaction is still in use".to_string()))?;',
        "            transaction.into_inner().commit().await?;",
        "        }",
        "        Ok(())",
    ],
}

SQL_ORM = {
    "id": "sql",
    "label": "sqlx",
    "error": "sqlx::Error",
    "emptyList": lambda context: (
        '"{}".to_string()' if context["settings"]["database"] == "postgresql" else '"[]".to_string()'
    ),
    "databaseFile": database_file,
    "entityFiles": lambda context, info: [entity_file(context, info)],
    "repository": {"uses": lambda *_: [], "body": sql_body, "helpers": sql_helpers},
    "unitOfWork": lambda *_: _UNIT,
    "testDatabaseFile": _test_database_file,
    "dependencies": _dependencies,
    "readme": {
        "intro": f"plain entities, repositories with their own SQL through sqlx {_SQLX} and services",
        "entities": "one entity per table",
        "table": "entity, repositories and service of each table",
        "folder": "The entities of every table.",
    },
}
