"""What every Rust project shares: the domain errors services return (no HTTP codes), the pages lists are read in,
Patch (a field of an update: absent, or a value that may be None), the connection DATABASE_URL names, and the unit of
work over the repositories, with its database and in-memory versions. A unit of work opens a transaction with begin();
its changes are kept by commit(), and dropped when it is dropped without one. Mirrors
web/src/core/generators/rust/support.ts."""

from .context import file_of, memory_repository, module_of, path_in, repository_trait, rs_file, sql_repository
from .rust import RsUses

ERRORS = "crate::errors"
COMMON = "crate::common"
DOMAIN_ERROR = f"{ERRORS}::DomainError"
UNIT_OF_WORK = "crate::unit_of_work::UnitOfWork"


def errors_file(context: dict) -> dict:
    return rs_file(
        file_of(ERRORS),
        "",
        [
            "/// What is wrong with one field.",
            "#[derive(Debug, Clone, PartialEq)]",
            "pub struct FieldError {",
            "    pub field: String,",
            "    pub message: String,",
            "}",
            "",
            "impl FieldError {",
            "    pub fn new(field: &str, message: &str) -> Self {",
            "        Self { field: field.to_string(), message: message.to_string() }",
            "    }",
            "}",
            "",
            "/// Every error a service returns.",
            "#[derive(Debug)]",
            "pub enum DomainError {",
            "    /// No row has this key.",
            "    NotFound { entity: String, key: String },",
            "    /// The change clashes with what is stored: a unique value, a newer version, rows that depend on it.",
            "    Conflict { entity: String, reason: String, fields: Vec<String> },",
            "    /// The values break the rules of the table: missing, too long, out of range, pointing nowhere.",
            "    ValidationFailed { entity: String, errors: Vec<FieldError> },",
            "    /// The database failed for another reason.",
            f"    Database({context['orm']['error']}),",
            "}",
            "",
            "impl DomainError {",
            "    /// No row of entity has this key.",
            "    pub fn not_found(entity: &str, key: impl std::fmt::Debug) -> Self {",
            '        DomainError::NotFound { entity: entity.to_string(), key: format!("{key:?}") }',
            "    }",
            "",
            "    /// The change clashes with what is stored, on these fields.",
            "    pub fn conflict(entity: &str, reason: &str, fields: &[&str]) -> Self {",
            "        DomainError::Conflict {",
            "            entity: entity.to_string(),",
            "            reason: reason.to_string(),",
            "            fields: fields.iter().map(|field| field.to_string()).collect(),",
            "        }",
            "    }",
            "}",
            "",
            "impl std::fmt::Display for DomainError {",
            "    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
            "        match self {",
            '            DomainError::NotFound { entity, key } => write!(f, "No {entity} has the key {key}"),',
            '            DomainError::Conflict { entity, reason, .. } => write!(f, "{entity}: {reason}"),',
            "            DomainError::ValidationFailed { entity, errors } => {",
            '                let problems: Vec<String> = errors.iter().map(|error| format!("{}: {}", error.field, error.message)).collect();',
            '                write!(f, "{entity}: {}", problems.join("; "))',
            "            }",
            '            DomainError::Database(error) => write!(f, "{error}"),',
            "        }",
            "    }",
            "}",
            "",
            "impl std::error::Error for DomainError {}",
            "",
            f"impl From<{context['orm']['error']}> for DomainError {{",
            f"    fn from(error: {context['orm']['error']}) -> Self {{",
            "        DomainError::Database(error)",
            "    }",
            "}",
        ],
        [
            "The errors services return on purpose. They carry no HTTP codes: whoever calls the services translates them."
        ],
    )


def common_file(context: dict) -> dict | None:
    settings = context["settings"]
    body: list[str] = []
    if settings["paging"] == "offset":
        body += [
            "/// A page of a list: the rows from an offset, and how many there are in all.",
            "#[derive(Debug, Clone, PartialEq)]",
            "pub struct Page<T> {",
            "    pub items: Vec<T>,",
            "    pub total: u64,",
            "    pub offset: u64,",
            "    pub limit: u64,",
            "}",
            "",
            "impl<T> Page<T> {",
            "    /// The same page with every row turned into something else.",
            "    pub fn map<R>(self, mapper: impl FnMut(T) -> R) -> Page<R> {",
            "        Page { items: self.items.into_iter().map(mapper).collect(), total: self.total, offset: self.offset, limit: self.limit }",
            "    }",
            "}",
        ]
    if settings["paging"] == "cursor":
        body += [
            "/// A page of a list read with a cursor: the rows after a key, and the key to read the next page from (None on the last page).",
            "#[derive(Debug, Clone, PartialEq)]",
            "pub struct CursorPage<T, K> {",
            "    pub items: Vec<T>,",
            "    pub next: Option<K>,",
            "}",
            "",
            "impl<T, K> CursorPage<T, K> {",
            "    /// The same page with every row turned into something else.",
            "    pub fn map<R>(self, mapper: impl FnMut(T) -> R) -> CursorPage<R, K> {",
            "        CursorPage { items: self.items.into_iter().map(mapper).collect(), next: self.next }",
            "    }",
            "}",
        ]
    if settings["services"] and settings["updates"] == "patch":
        body += [
            *([""] if body else []),
            "/// A field of an update: absent (it keeps its value), or set to a value, which may be None.",
            "#[derive(Debug, Clone, PartialEq)]",
            "pub enum Patch<T> {",
            "    Absent,",
            "    Set(T),",
            "}",
            "",
            "impl<T> Default for Patch<T> {",
            "    fn default() -> Self {",
            "        Patch::Absent",
            "    }",
            "}",
            "",
            "impl<T> Patch<T> {",
            "    /// The value given, or None when the field is absent.",
            "    pub fn given(self) -> Option<T> {",
            "        match self {",
            "            Patch::Absent => None,",
            "            Patch::Set(value) => Some(value),",
            "        }",
            "    }",
            "}",
        ]
    if not body:
        return None
    return rs_file(
        file_of(COMMON),
        "",
        body,
        ["What the services and repositories share: the pages lists are read in, and how updates come."],
    )


URLS = {
    "postgresql": "postgres://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mysql://app:app@localhost:3306/app",
    "sqlite": "sqlite://app.db?mode=rwc",
}


def default_url(context: dict) -> str:
    return context["orm"].get("url") or URLS.get(context["settings"]["database"], URLS["postgresql"])


HOW = {
    "operation": "Each service operation runs in a transaction of its own: begin() opens it, commit() keeps its changes.",
    "caller": "Services never commit: whoever holds the database opens the transaction (SqlUnitOfWork::in_transaction) and commits it.",
    "repository": "Every repository write is committed at once; services open no transaction.",
}


def repository_handle(context: dict, info: dict) -> str:
    """The type a unit of work hands a table's repository out as: its trait, or the database struct when there are none."""
    if context["settings"]["repositoryInterfaces"]:
        return f"Box<dyn {repository_trait(info)} + '_>"
    return f"{sql_repository(info)}<'_>"


def unit_of_work_file(context: dict) -> dict:
    """UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork."""
    settings = context["settings"]
    interfaces = settings["repositoryInterfaces"]
    memory = settings["memoryRepositories"]
    transactions = context["orm"]["unitOfWork"](context)
    uses = RsUses().add("async_trait::async_trait", *transactions["uses"])
    uses.add("crate::database::Db", DOMAIN_ERROR)
    for info in context["tables"]:
        module = module_of(context, info, "repository")
        uses.add(path_in(module, sql_repository(info)))
        if interfaces:
            uses.add(path_in(module, repository_trait(info)))
        if memory:
            uses.add(path_in(module, memory_repository(info)))

    def accessor(info: dict) -> str:
        return f"fn {info['attr']}(&self) -> {repository_handle(context, info)}"

    sql_accessors: list[str] = []
    for info in context["tables"]:
        made = (
            f"Box::new({sql_repository(info)}::new(&self.db))"
            if interfaces
            else f"{sql_repository(info)}::new(&self.db)"
        )
        sql_accessors += [f"    {accessor(info)} {{", f"        {made}", "    }", ""]
    memory_lines: list[str] = []
    if memory:
        memory_accessors: list[str] = []
        for info in context["tables"]:
            memory_accessors += [
                f"    {accessor(info)} {{",
                f"        Box::new(self.{info['attr']}.clone())",
                "    }",
                "",
            ]
        memory_lines = [
            "",
            "/// The in-memory repositories, for tests and for trying the services without a database. Memory has no",
            "/// transactions: changes are kept as they are made, and every copy of it shares the same rows.",
            "#[derive(Clone, Default)]",
            "pub struct MemoryUnitOfWork {",
            *(f"    {info['attr']}: {memory_repository(info)}," for info in context["tables"]),
            "}",
            "",
            "#[async_trait]",
            "impl UnitOfWork for MemoryUnitOfWork {",
            *memory_accessors,
            "    async fn begin(&self) -> Result<Box<dyn UnitOfWork>, DomainError> {",
            "        Ok(Box::new(self.clone()))",
            "    }",
            "",
            "    async fn commit(self: Box<Self>) -> Result<(), DomainError> {",
            "        Ok(())",
            "    }",
            "}",
        ]
    body = [
        f"/// What services depend on: a repository per table and transactions. {HOW[settings['transactions']]}",
        "#[async_trait]",
        "pub trait UnitOfWork: Send + Sync {",
        *(f"    {accessor(info)};" for info in context["tables"]),
        "",
        "    /// A unit of work in a new transaction: its changes are kept when it is committed, and dropped otherwise.",
        "    async fn begin(&self) -> Result<Box<dyn UnitOfWork>, DomainError>;",
        "",
        "    /// Keeps the changes of the transaction this unit of work is in.",
        "    async fn commit(self: Box<Self>) -> Result<(), DomainError>;",
        "}",
        "",
        "/// The repositories over one database, and its transactions.",
        "pub struct SqlUnitOfWork {",
        "    db: Db,",
        *transactions.get("fields", []),
        "}",
        "",
        "impl SqlUnitOfWork {",
        *transactions["constructors"],
        "}",
        "",
        "#[async_trait]",
        "impl UnitOfWork for SqlUnitOfWork {",
        *sql_accessors,
        "    async fn begin(&self) -> Result<Box<dyn UnitOfWork>, DomainError> {",
        *transactions["begin"],
        "    }",
        "",
        "    async fn commit(self: Box<Self>) -> Result<(), DomainError> {",
        *transactions["commit"],
        "    }",
        "}",
        *memory_lines,
    ]
    return rs_file(
        "src/unit_of_work.rs",
        uses.write(),
        body,
        ["The unit of work: the repositories of every table, and the transactions that group their writes."],
    )
