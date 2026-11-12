"""What every Java project shares: the domain errors services throw (no HTTP codes), the pages lists are read in,
Patch (a field of an update: absent, null or a value), the unit of work over the repositories, and the
EntityManagerFactory of the database DATABASE_URL names. Mirrors web/src/core/generators/java/support.ts."""

from ..types import lines
from .context import (
    common_package,
    errors_package,
    memory_repository_class,
    package_of,
    qualified,
    repository_type,
    sql_repository_class,
)
from .java import JavaImports, java_path

DOMAINEXCEPTION = [
    "/** Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them. */",
    "public abstract class DomainException extends RuntimeException {",
    "    protected DomainException(String message) {",
    "        super(message);",
    "    }",
    "}",
]

NOTFOUNDEXCEPTION = [
    "/** No row has this key. */",
    "public class NotFoundException extends DomainException {",
    "    private final String entity;",
    "    private final Object key;",
    "",
    "    public NotFoundException(String entity, Object key) {",
    '        super("No " + entity + " has the key " + key);',
    "        this.entity = entity;",
    "        this.key = key;",
    "    }",
    "",
    "    public String getEntity() {",
    "        return entity;",
    "    }",
    "",
    "    public Object getKey() {",
    "        return key;",
    "    }",
    "}",
]

CONFLICTEXCEPTION = [
    "/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */",
    "public class ConflictException extends DomainException {",
    "    private final String entity;",
    "    private final String reason;",
    "    private final List<String> fields;",
    "",
    "    public ConflictException(String entity, String reason, List<String> fields) {",
    '        super(entity + ": " + reason);',
    "        this.entity = entity;",
    "        this.reason = reason;",
    "        this.fields = List.copyOf(fields);",
    "    }",
    "",
    "    public ConflictException(String entity, String reason) {",
    "        this(entity, reason, List.of());",
    "    }",
    "",
    "    public String getEntity() {",
    "        return entity;",
    "    }",
    "",
    "    public String getReason() {",
    "        return reason;",
    "    }",
    "",
    "    public List<String> getFields() {",
    "        return fields;",
    "    }",
    "}",
]

FIELDERROR = [
    "/** What is wrong with one field. */",
    "public record FieldError(String field, String message) {}",
]

VALIDATIONFAILEDEXCEPTION = [
    "/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */",
    "public class ValidationFailedException extends DomainException {",
    "    private final String entity;",
    "    private final List<FieldError> errors;",
    "",
    "    public ValidationFailedException(String entity, List<FieldError> errors) {",
    '        super(entity + ": " + errors.stream().map((error) -> error.field() + ": " + error.message()).collect(Collectors.joining("; ")));',
    "        this.entity = entity;",
    "        this.errors = List.copyOf(errors);",
    "    }",
    "",
    "    public String getEntity() {",
    "        return entity;",
    "    }",
    "",
    "    public List<FieldError> getErrors() {",
    "        return errors;",
    "    }",
    "}",
]

PAGE = [
    "/** A page of a list: the rows from an offset, and how many there are in all. */",
    "public record Page<T>(List<T> items, long total, int offset, int limit) {",
    "    /** The same page with every row turned into something else. */",
    "    public <R> Page<R> map(Function<T, R> mapper) {",
    "        return new Page<>(items.stream().map(mapper).toList(), total, offset, limit);",
    "    }",
    "}",
]

CURSORPAGE = [
    "/** A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page). */",
    "public record CursorPage<T>(List<T> items, List<Object> next) {",
    "    /** The same page with every row turned into something else. */",
    "    public <R> CursorPage<R> map(Function<T, R> mapper) {",
    "        return new CursorPage<>(items.stream().map(mapper).toList(), next);",
    "    }",
    "}",
]

PATCH = [
    "/**",
    " * A field of an update: absent (it keeps its value), or present with a value, which may be null.",
    " *",
    " * @param <T> the type of the value",
    " */",
    "public final class Patch<T> {",
    "    private static final Patch<?> ABSENT = new Patch<>(false, null);",
    "",
    "    private final boolean present;",
    "    private final T value;",
    "",
    "    private Patch(boolean present, T value) {",
    "        this.present = present;",
    "        this.value = value;",
    "    }",
    "",
    "    /** The field keeps its value. */",
    '    @SuppressWarnings("unchecked")',
    "    public static <T> Patch<T> absent() {",
    "        return (Patch<T>) ABSENT;",
    "    }",
    "",
    "    /** The field takes this value, which may be null. */",
    "    public static <T> Patch<T> of(T value) {",
    "        return new Patch<>(true, value);",
    "    }",
    "",
    "    public boolean isPresent() {",
    "        return present;",
    "    }",
    "",
    "    /** The value to set; null when absent or set to null. */",
    "    public T value() {",
    "        return value;",
    "    }",
    "",
    "    @Override",
    "    public String toString() {",
    '        return present ? "Patch[" + value + "]" : "Patch.absent";',
    "    }",
    "}",
]


def _file(pkg: str, name: str, body: list[str], imports: JavaImports | None = None) -> dict:
    written = imports.write() if imports else ""
    return {
        "path": java_path(pkg, name),
        "content": lines(f"package {pkg};", "", written != "" and [written, ""], *body, ""),
    }


def error_files(context: dict) -> list[dict]:
    pkg = errors_package(context)
    return [
        _file(pkg, "DomainException", DOMAINEXCEPTION),
        _file(pkg, "NotFoundException", NOTFOUNDEXCEPTION),
        _file(pkg, "ConflictException", CONFLICTEXCEPTION, JavaImports(pkg).add("java.util.List")),
        _file(pkg, "FieldError", FIELDERROR),
        _file(
            pkg,
            "ValidationFailedException",
            VALIDATIONFAILEDEXCEPTION,
            JavaImports(pkg).add("java.util.List", "java.util.stream.Collectors"),
        ),
    ]


def common_files(context: dict) -> list[dict]:
    pkg = common_package(context)
    settings = context["settings"]
    files = []
    if settings["paging"] == "offset":
        files.append(_file(pkg, "Page", PAGE, JavaImports(pkg).add("java.util.List", "java.util.function.Function")))
    if settings["paging"] == "cursor":
        files.append(
            _file(pkg, "CursorPage", CURSORPAGE, JavaImports(pkg).add("java.util.List", "java.util.function.Function"))
        )
    if settings["services"] and settings["updates"] == "patch":
        files.append(_file(pkg, "Patch", PATCH))
    return files


HOW = {
    "operation": "Each service operation runs in transaction(): committed when it ends, rolled back when it fails.",
    "caller": "Services never commit: whoever holds the EntityManager opens and ends its transaction; transaction() only groups the code.",
    "repository": "Every repository write is committed at once; transaction() only groups the code.",
}


def unit_of_work_files(context: dict) -> list[dict]:
    """UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork, in the base package."""
    pkg = context["base"]
    settings = context["settings"]
    tables = context["tables"]

    def type_imports(imports: JavaImports, kind: str) -> JavaImports:
        for info in tables:
            if kind == "interface":
                imports.add(qualified(context, info, "repository", repository_type(context, info)))
            if kind == "sql":
                imports.add(qualified(context, info, "repository", sql_repository_class(info)))
            if kind == "memory":
                imports.add(qualified(context, info, "repository", memory_repository_class(info)))
            if kind != "interface":
                imports.add(qualified(context, info, "repository", repository_type(context, info)))
        return imports

    def accessors() -> list[str]:
        result = []
        for info in tables:
            result += [
                "",
                "    @Override",
                f"    public {repository_type(context, info)} {info['attr']}() {{",
                f"        return {info['attr']};",
                "    }",
            ]
        return result

    files = [
        _file(
            pkg,
            "UnitOfWork",
            [
                f"/** What services depend on: a repository per table and a transaction. {HOW[settings['transactions']]} */",
                "public interface UnitOfWork {",
                *(f"    {repository_type(context, info)} {info['attr']}();" for info in tables),
                "",
                "    /** Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws. */",
                "    <T> T transaction(Function<UnitOfWork, T> work);",
                "}",
            ],
            type_imports(JavaImports(pkg).add("java.util.function.Function"), "interface"),
        )
    ]
    operation = settings["transactions"] == "operation"
    if operation:
        transaction = [
            "        EntityTransaction transaction = entityManager.getTransaction();",
            "        // Joins the transaction already open",
            "        if (transaction.isActive()) return work.apply(this);",
            "        transaction.begin();",
            "        try {",
            "            T result = work.apply(this);",
            "            transaction.commit();",
            "            return result;",
            "        } catch (RuntimeException error) {",
            "            if (transaction.isActive()) transaction.rollback();",
            "            throw error;",
            "        }",
        ]
    else:
        transaction = ["        return work.apply(this);"]
    sql_imports = JavaImports(pkg).add(
        "jakarta.persistence.EntityManager",
        "java.util.function.Function",
        *(["jakarta.persistence.EntityTransaction"] if operation else []),
    )
    files.append(
        _file(
            pkg,
            "SqlUnitOfWork",
            [
                "/** The repositories over one EntityManager, and its transaction. */",
                "public class SqlUnitOfWork implements UnitOfWork {",
                "    private final EntityManager entityManager;",
                *(f"    private final {repository_type(context, info)} {info['attr']};" for info in tables),
                "",
                "    public SqlUnitOfWork(EntityManager entityManager) {",
                "        this.entityManager = entityManager;",
                *(f"        this.{info['attr']} = new {sql_repository_class(info)}(entityManager);" for info in tables),
                "    }",
                "",
                "    public EntityManager entityManager() {",
                "        return entityManager;",
                "    }",
                *accessors(),
                "",
                "    @Override",
                "    public <T> T transaction(Function<UnitOfWork, T> work) {",
                *transaction,
                "    }",
                "}",
            ],
            type_imports(sql_imports, "sql"),
        )
    )
    if settings["memoryRepositories"]:
        files.append(
            _file(
                pkg,
                "MemoryUnitOfWork",
                [
                    "/** The in-memory repositories, for tests and for trying the services without a database. */",
                    "public class MemoryUnitOfWork implements UnitOfWork {",
                    *(
                        f"    private final {repository_type(context, info)} {info['attr']} = new {memory_repository_class(info)}();"
                        for info in tables
                    ),
                    *accessors(),
                    "",
                    "    /** Memory has no transactions: changes are kept as they are made. */",
                    "    @Override",
                    "    public <T> T transaction(Function<UnitOfWork, T> work) {",
                    "        return work.apply(this);",
                    "    }",
                    "}",
                ],
                type_imports(JavaImports(pkg).add("java.util.function.Function"), "memory"),
            )
        )
    return files


URLS = {
    "postgresql": "jdbc:postgresql://localhost:5432/app",
    "mysql": "jdbc:mysql://localhost:3306/app",
    "mariadb": "jdbc:mariadb://localhost:3306/app",
    "sqlite": "jdbc:sqlite:app.db?foreign_keys=true",
}


def database_file(context: dict) -> dict:
    """Database: the EntityManagerFactory of the database DATABASE_URL names, with every entity."""
    pkg = context["base"]
    imports = JavaImports(pkg).add(
        "jakarta.persistence.EntityManagerFactory", "org.hibernate.jpa.HibernatePersistenceConfiguration"
    )
    for info in context["tables"]:
        imports.add(f"{package_of(context, info, 'entity')}.{info['entity']}")
    url = URLS.get(context["settings"]["database"])
    entities = ", ".join(f"{info['entity']}.class" for info in context["tables"])
    return _file(
        pkg,
        "Database",
        [
            "/** The database DATABASE_URL names (a JDBC URL; DATABASE_USER and DATABASE_PASSWORD), through Hibernate. */",
            "public final class Database {",
            f'    public static final String DEFAULT_URL = "{url}";',
            "",
            "    private Database() {}",
            "",
            "    /** Every entity, so Hibernate knows every table */",
            f"    public static final List<Class<?>> ENTITIES = List.of({entities});",
            "",
            "    /** The configuration of the database at url: give it a connection pool or a DataSource for production. */",
            "    public static HibernatePersistenceConfiguration configuration(String url, String user, String password) {",
            '        HibernatePersistenceConfiguration configuration = new HibernatePersistenceConfiguration("app")',
            "                .managedClasses(ENTITIES)",
            "                .jdbcUrl(url)",
            "                // The services check the values; the database fills its defaults",
            '                .property("hibernate.check_nullability", false)',
            "                // Every name is quoted, so names like rank or order work and are used exactly as the database has them",
            '                .property("hibernate.globally_quoted_identifiers", true)',
            '                .property("hibernate.globally_quoted_identifiers_skip_column_definitions", true);',
            '        if (user != null) configuration.jdbcCredentials(user, password == null ? "" : password);',
            "        return configuration;",
            "    }",
            "",
            "    /** The EntityManagerFactory of DATABASE_URL, DATABASE_USER and DATABASE_PASSWORD. */",
            "    public static EntityManagerFactory open() {",
            '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
            '        return configuration(url, System.getenv("DATABASE_USER"), System.getenv("DATABASE_PASSWORD")).createEntityManagerFactory();',
            "    }",
            "}",
        ],
        imports.add("java.util.List"),
    )
