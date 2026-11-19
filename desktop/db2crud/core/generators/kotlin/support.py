"""What every Kotlin project shares: the domain errors services throw (no HTTP codes), the pages lists are read in,
Patch (a field of an update: absent, or a value that may be null), the connection DATABASE_URL names, and the unit of
work over the repositories, with its database and in-memory versions. Mirrors
web/src/core/generators/kotlin/support.ts."""

from .context import (
    common_package,
    errors_package,
    kt_file,
    memory_repository_class,
    package_of,
    path_of,
    qualified,
    repository_type,
    sql_repository_class,
)
from .kotlin import KtImports, kt_string


def errors_file(context: dict) -> dict:
    pkg = errors_package(context)
    return kt_file(
        path_of(pkg, "Errors"),
        pkg,
        "",
        [
            "/** Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them. */",
            "abstract class DomainException(message: String) : RuntimeException(message)",
            "",
            "/** No row has this key. */",
            "class NotFoundException(val entity: String, val key: Any) :",
            '    DomainException("No $entity has the key ${if (key is List<*>) key.joinToString(", ") else key}")',
            "",
            "/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */",
            "class ConflictException(val entity: String, val reason: String, val fields: List<String> = emptyList()) :",
            '    DomainException("$entity: $reason")',
            "",
            "/** What is wrong with one field. */",
            "data class FieldError(val field: String, val message: String)",
            "",
            "/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */",
            "class ValidationFailedException(val entity: String, val errors: List<FieldError>) :",
            '    DomainException("$entity: " + errors.joinToString("; ") { "${it.field}: ${it.message}" })',
        ],
    )


def common_files(context: dict) -> list[dict]:
    pkg = common_package(context)
    settings = context["settings"]
    files: list[dict] = []
    if settings["paging"] == "offset":
        files.append(
            kt_file(
                path_of(pkg, "Page"),
                pkg,
                "",
                [
                    "/** A page of a list: the rows from an offset, and how many there are in all. */",
                    "data class Page<T>(val items: List<T>, val total: Long, val offset: Int, val limit: Int) {",
                    "    /** The same page with every row turned into something else. */",
                    "    fun <R> map(mapper: (T) -> R): Page<R> = Page(items.map(mapper), total, offset, limit)",
                    "}",
                ],
            )
        )
    if settings["paging"] == "cursor":
        files.append(
            kt_file(
                path_of(pkg, "CursorPage"),
                pkg,
                "",
                [
                    "/** A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page). */",
                    "data class CursorPage<T>(val items: List<T>, val next: List<Any>?) {",
                    "    /** The same page with every row turned into something else. */",
                    "    fun <R> map(mapper: (T) -> R): CursorPage<R> = CursorPage(items.map(mapper), next)",
                    "}",
                ],
            )
        )
    if settings["services"] and settings["updates"] == "patch":
        files.append(
            kt_file(
                path_of(pkg, "Patch"),
                pkg,
                "",
                [
                    "/** A field of an update: absent (it keeps its value), or present with a value, which may be null. */",
                    "class Patch<out T> private constructor(val isPresent: Boolean, val value: T?) {",
                    '    override fun toString(): String = if (isPresent) "Patch[$value]" else "Patch.absent"',
                    "",
                    "    companion object {",
                    "        private val ABSENT = Patch<Nothing>(false, null)",
                    "",
                    "        /** The field keeps its value. */",
                    "        fun <T> absent(): Patch<T> = ABSENT",
                    "",
                    "        /** The field takes this value, which may be null. */",
                    "        fun <T> of(value: T?): Patch<T> = Patch(true, value)",
                    "    }",
                    "}",
                ],
            )
        )
    return files


# Exposed's transaction, by another name than the unit of work's own transaction()
EXPOSED_TRANSACTION = "org.jetbrains.exposed.v1.jdbc.transactions.transaction as exposedTransaction"

URLS = {
    "postgresql": "jdbc:postgresql://localhost:5432/app",
    "mysql": "jdbc:mysql://localhost:3306/app",
    "mariadb": "jdbc:mariadb://localhost:3306/app",
    "sqlite": "jdbc:sqlite:app.db",
}


def default_url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


def database_file(context: dict) -> dict:
    """AppDatabase: the database DATABASE_URL names (with DATABASE_USER and DATABASE_PASSWORD)."""
    pkg = context["base"]
    return kt_file(
        path_of(pkg, "AppDatabase"),
        pkg,
        "import org.jetbrains.exposed.v1.jdbc.Database",
        [
            "/** The database DATABASE_URL names (a JDBC URL), through Exposed. It never migrates: the database already exists. */",
            "object AppDatabase {",
            f"    const val DEFAULT_URL = {kt_string(default_url(context))}",
            "",
            "    /** A connection to the database at url (DATABASE_URL, with DATABASE_USER and DATABASE_PASSWORD, by default). */",
            "    fun connect(",
            '        url: String = System.getenv("DATABASE_URL") ?: DEFAULT_URL,',
            '        user: String = System.getenv("DATABASE_USER") ?: "",',
            '        password: String = System.getenv("DATABASE_PASSWORD") ?: "",',
            "    ): Database = Database.connect(url, user = user, password = password)",
            "}",
        ],
    )


HOW = {
    "operation": "Each service operation runs in transaction(): committed when it ends, rolled back when it throws.",
    "caller": "Services never commit: whoever holds the database opens and ends its transaction; transaction() only groups the code.",
    "repository": "Every repository write is committed at once; transaction() only groups the code.",
}


def _properties(context: dict, imports: KtImports, value) -> list[str]:
    lines = []
    for info in context["tables"]:
        imports.add(qualified(package_of(context, info, "repository"), repository_type(context, info)))
        lines.append(f"    override val {info['attr']}: {repository_type(context, info)} = {value(info)}")
    return lines


def unit_of_work_files(context: dict) -> list[dict]:
    """UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork, in the base package."""
    pkg = context["base"]
    settings = context["settings"]
    interface_imports = KtImports(pkg)
    members = []
    for info in context["tables"]:
        interface_imports.add(qualified(package_of(context, info, "repository"), repository_type(context, info)))
        members.append(f"    val {info['attr']}: {repository_type(context, info)}")
    files = [
        kt_file(
            path_of(pkg, "UnitOfWork"),
            pkg,
            interface_imports.write(),
            [
                f"/** What services depend on: a repository per table and a transaction. {HOW[settings['transactions']]} */",
                "interface UnitOfWork {",
                *members,
                "",
                "    /** Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws. */",
                "    fun <T> transaction(work: (UnitOfWork) -> T): T",
                "}",
            ],
        )
    ]
    sql_imports = KtImports(pkg).add("org.jetbrains.exposed.v1.jdbc.Database")
    for info in context["tables"]:
        sql_imports.add(qualified(package_of(context, info, "repository"), sql_repository_class(info)))
    sql_properties = _properties(context, sql_imports, lambda info: f"{sql_repository_class(info)}(db)")
    operation = settings["transactions"] == "operation"
    if operation:
        sql_imports.add(EXPOSED_TRANSACTION)
    owner = (
        "The transaction belongs to whoever holds the database"
        if settings["transactions"] == "caller"
        else "Every write is committed at once"
    )
    files.append(
        kt_file(
            path_of(pkg, "SqlUnitOfWork"),
            pkg,
            sql_imports.write(),
            [
                "/** The repositories over one database, and its transaction. */",
                "class SqlUnitOfWork(val db: Database) : UnitOfWork {",
                *sql_properties,
                "",
                "    /** Joins the transaction already open, or opens one. */"
                if operation
                else f"    /** {owner}: this only groups the code. */",
                "    override fun <T> transaction(work: (UnitOfWork) -> T): T = exposedTransaction(db) { work(this@SqlUnitOfWork) }"
                if operation
                else "    override fun <T> transaction(work: (UnitOfWork) -> T): T = work(this)",
                "}",
            ],
        )
    )
    if settings["memoryRepositories"]:
        imports = KtImports(pkg)
        for info in context["tables"]:
            imports.add(qualified(package_of(context, info, "repository"), memory_repository_class(info)))
        memory_properties = _properties(context, imports, lambda info: f"{memory_repository_class(info)}()")
        files.append(
            kt_file(
                path_of(pkg, "MemoryUnitOfWork"),
                pkg,
                imports.write(),
                [
                    "/** The in-memory repositories, for tests and for trying the services without a database. */",
                    "class MemoryUnitOfWork : UnitOfWork {",
                    *memory_properties,
                    "",
                    "    /** Memory has no transactions: changes are kept as they are made. */",
                    "    override fun <T> transaction(work: (UnitOfWork) -> T): T = work(this)",
                    "}",
                ],
            )
        )
    return files
