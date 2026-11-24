"""* The database layer of a Rust project without an ORM: database.rs, with the sqlx pool of DATABASE_URL and Db, what the
repositories run their SQL on (the pool, or a transaction opened on it); how each column is selected, read and written;
and the entities, plain structs with a field per column. Mirrors
web/src/core/generators/rust/sql/database.ts."""

from ....schema.ddl import quote_name, type_sql
from ..context import file_of, module_of, rs_file
from ..rust import rs_string
from ..support import default_url


def _is_mysql(database: str):
    return database == "mysql" or database == "mariadb"


def driver_types(context: dict) -> dict:
    """The names of sqlx for the kind of database: the pool, the database, the row and the result of a write."""
    database = context["settings"]["database"]
    if database == "sqlite":
        return {
            "pool": "SqlitePool",
            "database": "Sqlite",
            "row": "SqliteRow",
            "result": "SqliteQueryResult",
            "feature": "sqlite",
        }
    if _is_mysql(database):
        return {
            "pool": "MySqlPool",
            "database": "MySql",
            "row": "MySqlRow",
            "result": "MySqlQueryResult",
            "feature": "mysql",
        }
    return {"pool": "PgPool", "database": "Postgres", "row": "PgRow", "result": "PgQueryResult", "feature": "postgres"}


_DOCS = {"sqlite": "sqlite", "mysql": "mysql", "postgres": "postgres"}


def _insert_lines(context: dict) -> list[str]:
    """insert_sql: an insert of the columns given."""
    if context["settings"]["database"] == "postgresql":
        return [
            "/// An insert of the columns given, each one with the cast of its value; without any, of the defaults of the table.",
            "pub fn insert_sql(table: &str, given: &[(&str, &str)]) -> String {",
            "    if given.is_empty() {",
            '        return format!("INSERT INTO {table} DEFAULT VALUES");',
            "    }",
            "    let names: Vec<&str> = given.iter().map(|(name, _)| *name).collect();",
            '    let marks: Vec<String> = given.iter().enumerate().map(|(index, (_, cast))| format!("${}{cast}", index + 1)).collect();',
            '    format!("INSERT INTO {table} ({}) VALUES ({})", names.join(", "), marks.join(", "))',
            "}",
        ]
    return [
        "/// An insert of the columns given; without any, of the defaults of the table.",
        "pub fn insert_sql(table: &str, given: &[&str]) -> String {",
        "    if given.is_empty() {",
        f'        return format!("INSERT INTO {{table}} {("DEFAULT VALUES" if context["settings"]["database"] == "sqlite" else "() VALUES ()")}");',
        "    }",
        '    format!("INSERT INTO {table} ({}) VALUES ({})", given.join(", "), vec!["?"; given.len()].join(", "))',
        "}",
    ]


def database_file(context: dict) -> dict:
    """database.rs: the pool of DATABASE_URL, and Db, what repositories run their SQL on."""
    types = driver_types(context)
    inserts = any(any(item["kind"] == "insert" for item in info["queries"]) for info in context["tables"])
    return rs_file(
        "src/database.rs",
        "\n".join(
            ["use std::sync::Arc;", "", "use sqlx::{Database, SqlSafeStr, Transaction};", "use tokio::sync::Mutex;"]
        ),
        [
            f"pub const DEFAULT_URL: &str = {rs_string(default_url(context))};",
            "",
            f"pub type Pool = sqlx::{types['pool']};",
            f"pub type Driver = sqlx::{types['database']};",
            f"pub type DbRow = sqlx::{_DOCS.get(types['feature'])}::{types['row']};",
            f"pub type DbResult = sqlx::{_DOCS.get(types['feature'])}::{types['result']};",
            "/// A statement with its values.",
            "pub type Query<'q> = sqlx::query::Query<'q, Driver, <Driver as Database>::Arguments>;",
            "",
            "/// A pool of connections to the database at DATABASE_URL (DEFAULT_URL when it is not set).",
            "pub async fn connect() -> Result<Pool, sqlx::Error> {",
            '    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());',
            "    Pool::connect(&url).await",
            "}",
            "",
            "/// What repositories run their SQL on: the pool, or a transaction opened on it.",
            "pub enum Db {",
            "    Pool(Pool),",
            "    Transaction(Arc<Mutex<Transaction<'static, Driver>>>),",
            "    /// A transaction another unit of work opened, and commits.",
            "    Joined(Arc<Mutex<Transaction<'static, Driver>>>),",
            "}",
            "",
            "impl Db {",
            "    /// Every row of a query.",
            "    pub async fn all(&self, query: Query<'_>) -> Result<Vec<DbRow>, sqlx::Error> {",
            "        match self {",
            "            Db::Pool(pool) => query.fetch_all(pool).await,",
            "            Db::Transaction(transaction) | Db::Joined(transaction) => query.fetch_all(&mut **transaction.lock().await).await,",
            "        }",
            "    }",
            "",
            "    /// The first row of a query, if there is one.",
            "    pub async fn one(&self, query: Query<'_>) -> Result<Option<DbRow>, sqlx::Error> {",
            "        match self {",
            "            Db::Pool(pool) => query.fetch_optional(pool).await,",
            "            Db::Transaction(transaction) | Db::Joined(transaction) => query.fetch_optional(&mut **transaction.lock().await).await,",
            "        }",
            "    }",
            "",
            "    /// Runs a statement that reads nothing back.",
            "    pub async fn run(&self, query: Query<'_>) -> Result<DbResult, sqlx::Error> {",
            "        match self {",
            "            Db::Pool(pool) => query.execute(pool).await,",
            "            Db::Transaction(transaction) | Db::Joined(transaction) => query.execute(&mut **transaction.lock().await).await,",
            "        }",
            "    }",
            "}",
            "",
            "/// A statement, whose values are bound to it in order. Its text is written by the repositories: no value is ever part of it.",
            "pub fn statement<'q>(sql: impl Into<String>) -> Query<'q> {",
            "    sqlx::query(sqlx::AssertSqlSafe(sql.into()).into_sql_str())",
            "}",
            *(["", *_insert_lines(context)] if inserts else []),
        ],
        ["The database DATABASE_URL names, through sqlx. It never migrates: the database already exists."],
    )


# The kinds sqlx takes and gives as text only through a cast of PostgreSQL.
_AS_TEXT = set(["enum", "json", "array", "unknown"])


def selected(context: dict, column: dict) -> str:
    """ "status"::text: a column as a read selects it."""
    name = quote_name(context["settings"]["database"], column["column"]["name"])
    type_ = column["column"]["type"]
    if context["settings"]["database"] == "postgresql":
        if type_["kind"] in _AS_TEXT:
            return f"{name}::text"
        return f"{name}::time" if type_["kind"] == "time" and type_["timezone"] else name
    # sqlx has no decimals on SQLite: they are read from their text
    return (
        f"CAST({name} AS TEXT)" if context["settings"]["database"] == "sqlite" and type_["kind"] == "decimal" else name
    )


def cast(context: dict, column: dict) -> str:
    """::"mood": how PostgreSQL turns the text sent into the type of the column; nothing for the others."""
    if context["settings"]["database"] != "postgresql" or column["column"]["type"]["kind"] not in _AS_TEXT:
        return ""
    type_ = column["column"]["type"]
    if type_["kind"] == "enum":
        item = next((candidate for candidate in context["schema"]["enums"] if candidate["name"] == type_["name"]), None)
        return f"::{quote_name('postgresql', type_['name'])}" if (item or {}).get("storage") == "native" else ""
    return f"::{type_sql(context['schema'], 'postgresql', type_)}"


_DATE_TIME = "chrono::DateTime<chrono::FixedOffset>"


def _driver_value(context: dict, column: dict) -> dict:
    """The type a value has for the driver, and how it becomes the one of the entity (value is the driver's)."""
    database = context["settings"]["database"]
    if column["rs"] == _DATE_TIME:
        # MySQL keeps no zone: the times are in UTC
        if _is_mysql(database):
            return {"type": "chrono::NaiveDateTime", "from": "value.and_utc().fixed_offset()"}
        return {"type": "chrono::DateTime<chrono::Utc>", "from": "value.fixed_offset()"}
    if column["rs"] == "uuid::Uuid" and database != "postgresql":
        return {"type": "uuid::fmt::Hyphenated", "from": "value.into_uuid()"}
    if column["rs"] == "rust_decimal::Decimal" and database == "sqlite":
        return {"type": "String", "from": "decimal", "fallible": True}
    return {"type": column["rs"], "from": None}


def read_column(context: dict, column: dict, index: int) -> str:
    """A column of a row, as the field of the entity keeps it."""
    # The columns of MySQL and SQLite are of the type the schema says, whatever sqlx calls it
    get = "try_get" if context["settings"]["database"] == "postgresql" else "try_get_unchecked"
    driver = _driver_value(context, column)
    type_ = driver["type"]
    from_ = driver["from"]
    fallible = driver.get("fallible", False)
    read = f"row.{get}::<Option<{type_}>, _>({index})?"
    if from_ is None:
        return read
    if fallible:
        scale = column["column"]["type"].get("scale") if column["column"]["type"]["kind"] == "decimal" else None
        return (
            f"{read}.map(|value| decimal(&value, " + ("None" if scale is None else f"Some({scale})") + ")).transpose()?"
        )
    return f"{read}.map(|value| {from_})"


def write_value(context: dict, column: dict, expression: str) -> str:
    """A value of the entity's type, as the driver takes it."""
    database = context["settings"]["database"]
    if column["rs"] == _DATE_TIME:
        return f"{expression}.naive_utc()" if _is_mysql(database) else f"{expression}.with_timezone(&chrono::Utc)"
    if column["rs"] == "uuid::Uuid" and database != "postgresql":
        return f"{expression}.hyphenated()"
    return (
        f"{expression}.to_string()" if column["rs"] == "rust_decimal::Decimal" and database == "sqlite" else expression
    )


def reads_decimals(context: dict, info: dict):
    """Whether a table has a decimal SQLite keeps as a number."""
    return context["settings"]["database"] == "sqlite" and any(
        column["rs"] == "rust_decimal::Decimal" for column in info["columns"]
    )


def entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a struct with a field per column, None until it is set or read."""
    comment = f": {info['table'].get('comment')}" if info["table"].get("comment") else ""
    kept = " (an array literal of PostgreSQL)" if context["settings"]["database"] == "postgresql" else " (JSON)"
    fields = [
        line
        for column in info["columns"]
        for line in [
            *(
                [f'    // TODO: "{column["column"]["type"]["sql"]}" has no Rust type here; it is kept as its text']
                if column["column"]["type"]["kind"] == "unknown"
                else []
            ),
            *(
                [f'    // TODO: "{column["column"]["type"]["sql"]}" is kept as its text{kept}']
                if column["column"]["type"]["kind"] == "array"
                else []
            ),
            f"    pub {column['field']}: Option<{column['rs']}>,",
        ]
    ]
    return rs_file(
        file_of(module_of(context, info, "entity")),
        "",
        [
            f'/// A row of the "{info["name"]}" table{comment}. The repositories read and write it with SQL; a field stays `None` until it is set or read.',
            "#[derive(Debug, Clone, Default, PartialEq)]",
            f"pub struct {info['entity']} {{",
            *fields,
            "}",
        ],
    )
