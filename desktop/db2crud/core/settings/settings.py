"""The settings of a generated project (docs/design.md, section 4): every choice that is a matter of taste or of the
project around the code. Mirrors web/src/core/settings/settings.ts.

Settings are a dictionary with the keys of ProjectSettings. A stack offers the options it can honour, and
normalize_settings turns any settings into ones the chosen stack supports.
"""

import re
import unicodedata

STACKS = [
    {
        "language": "python",
        "orm": "sqlalchemy",
        "label": "SQLAlchemy 2",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["sync", "async"],
        # Python has no common result type: exceptions are its way
        "errors": ["exceptions"],
        "dtoKinds": ["pydantic", "dataclass"],
        "updates": ["partial"],
    },
    {
        "language": "python",
        "orm": "django",
        "label": "Django 5.2",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # Django's asynchronous ORM cannot hold a transaction (transaction.atomic is synchronous only)
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["pydantic", "dataclass"],
        "updates": ["partial"],
    },
    {
        "language": "python",
        "orm": "sql",
        "label": "SQL (psycopg · MySQL Connector · sqlite3)",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # The drivers are synchronous
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["pydantic", "dataclass"],
        "updates": ["partial"],
    },
    {
        "language": "typescript",
        "orm": "typeorm",
        "label": "TypeORM 0.3",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # Every database call in Node returns a promise
        "execution": ["async"],
        # TypeScript has no common result type: errors are thrown
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
        "updates": ["partial"],
    },
    {
        "language": "typescript",
        "orm": "prisma",
        "label": "Prisma 7",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
        "updates": ["partial"],
    },
    {
        "language": "typescript",
        "orm": "drizzle",
        "label": "Drizzle 0.45",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
        "updates": ["partial"],
    },
    {
        "language": "typescript",
        "orm": "sequelize",
        "label": "Sequelize 6",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
        "updates": ["partial"],
    },
    {
        "language": "typescript",
        "orm": "sql",
        "label": "SQL (pg · mysql2 · better-sqlite3)",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
        "updates": ["partial"],
    },
    {
        "language": "java",
        "orm": "jpa",
        "label": "JPA · Hibernate 7",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # JPA is blocking: an EntityManager has no asynchronous API
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["record", "class"],
        "updates": ["patch", "optional", "full"],
    },
    {
        "language": "java",
        "orm": "sql",
        "label": "SQL (JDBC)",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # JDBC is blocking
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["record", "class"],
        "updates": ["patch", "optional", "full"],
    },
    {
        "language": "csharp",
        "orm": "efcore",
        "label": "EF Core 9",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["record", "class"],
        # .NET has no Optional<T>: a Patch<T> or every field
        "updates": ["patch", "full"],
    },
    {
        "language": "csharp",
        "orm": "sql",
        "label": "SQL (ADO.NET)",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["record", "class"],
        "updates": ["patch", "full"],
    },
    {
        "language": "php",
        "orm": "doctrine",
        "label": "Doctrine ORM 3",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # PHP's database calls block
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["readonly", "class"],
        # PHP has no Optional<T>: a Patch per field, an array of the changed fields, or every field
        "updates": ["patch", "partial", "full"],
    },
    {
        "language": "php",
        "orm": "eloquent",
        "label": "Eloquent 12",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["readonly", "class"],
        "updates": ["patch", "partial", "full"],
    },
    {
        "language": "kotlin",
        "orm": "exposed",
        "label": "Exposed 1.6",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # Exposed's JDBC transactions block
        "execution": ["sync"],
        "errors": ["exceptions"],
        "dtoKinds": ["data", "class"],
        "updates": ["patch", "optional", "full"],
    },
    {
        "language": "rust",
        "orm": "seaorm",
        "label": "SeaORM 2",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # SeaORM is asynchronous only
        "execution": ["async"],
        # Rust has no exceptions: every operation returns a Result
        "errors": ["results"],
        "dtoKinds": ["struct"],
        # Option<Option<T>> is Rust's way of telling a field not sent from a field emptied
        "updates": ["patch", "optional", "full"],
    },
    {
        "language": "swift",
        "orm": "fluent",
        "label": "Fluent 1 (FluentKit)",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        # Fluent's API is async/await
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["struct"],
        # T?? is Swift's way of telling a field not sent from a field emptied
        "updates": ["patch", "optional", "full"],
    },
]

DEFAULT_SETTINGS = {
    "name": "data-access",
    "language": "python",
    "orm": "sqlalchemy",
    "database": "postgresql",
    "entities": "missing",
    "entitiesModule": "app.entities",
    "modelsSource": "copy",
    "modelsModule": "app.application_models",
    "services": True,
    "serviceTypes": "entities",
    "dtoKind": "pydantic",
    "updates": "partial",
    "transactions": "operation",
    "execution": "sync",
    "errors": "exceptions",
    "repositoryInterfaces": True,
    "memoryRepositories": True,
    "paging": "offset",
    "architecture": "layer",
    "verbs": "getFind",
    "tests": "all",
}

ENTITIES = ["missing", "all", "none"]
SERVICE_TYPES = ["entities", "dtos"]
TRANSACTIONS = ["operation", "caller", "repository"]
PAGING = ["none", "offset", "cursor"]
ARCHITECTURES = ["layer", "table"]
VERBS = ["getFind", "get", "find"]
TESTS = ["all", "services", "repositories", "none"]


def find_stack(language, orm) -> dict | None:
    return next((stack for stack in STACKS if stack["language"] == language and stack["orm"] == orm), None)


def _pick(value, options: list, fallback):
    return value if isinstance(value, str) and value in options else fallback


def _bool(value, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def slug(name: str) -> str:
    """Shop Data! → shop-data; empty names fall back to the default."""
    plain = "".join(char for char in unicodedata.normalize("NFD", name) if not ("\u0300" <= char <= "\u036f")).lower()
    words = [word for word in re.split(r"[^a-z0-9]+", plain) if word]
    return "-".join(words) if words else DEFAULT_SETTINGS["name"]


def _module_path(value, fallback: str) -> str:
    valid = isinstance(value, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*", value)
    return value if valid else fallback


def normalize_settings(settings: dict) -> dict:
    """Settings the chosen stack supports: unknown values and options it cannot honour fall back to its first one."""
    stack = find_stack(settings.get("language"), settings.get("orm")) or STACKS[0]
    services = _bool(settings.get("services"), DEFAULT_SETTINGS["services"])
    tests = _pick(settings.get("tests"), TESTS, DEFAULT_SETTINGS["tests"])
    if not services and tests == "services":
        tests = "none"
    elif not services and tests == "all":
        tests = "repositories"
    name = settings.get("name")
    return {
        "name": slug(name if isinstance(name, str) else DEFAULT_SETTINGS["name"]),
        "language": stack["language"],
        "orm": stack["orm"],
        "database": _pick(settings.get("database"), stack["databases"], stack["databases"][0]),
        "entities": _pick(settings.get("entities"), ENTITIES, DEFAULT_SETTINGS["entities"]),
        "entitiesModule": _module_path(settings.get("entitiesModule"), DEFAULT_SETTINGS["entitiesModule"]),
        "modelsSource": _pick(settings.get("modelsSource"), ("copy", "import"), DEFAULT_SETTINGS["modelsSource"]),
        "modelsModule": _module_path(settings.get("modelsModule"), DEFAULT_SETTINGS["modelsModule"]),
        "services": services,
        "serviceTypes": _pick(settings.get("serviceTypes"), SERVICE_TYPES, DEFAULT_SETTINGS["serviceTypes"]),
        "dtoKind": _pick(settings.get("dtoKind"), stack["dtoKinds"], stack["dtoKinds"][0]),
        "updates": _pick(settings.get("updates"), stack["updates"], stack["updates"][0]),
        "transactions": _pick(settings.get("transactions"), TRANSACTIONS, DEFAULT_SETTINGS["transactions"]),
        "execution": _pick(settings.get("execution"), stack["execution"], stack["execution"][0]),
        "errors": _pick(settings.get("errors"), stack["errors"], stack["errors"][0]),
        "repositoryInterfaces": _bool(settings.get("repositoryInterfaces"), DEFAULT_SETTINGS["repositoryInterfaces"]),
        # Rust has no inheritance: without the traits, nothing in memory can stand in for the database repositories
        "memoryRepositories": False
        if stack["language"] == "rust" and settings.get("repositoryInterfaces") is False
        else _bool(settings.get("memoryRepositories"), DEFAULT_SETTINGS["memoryRepositories"]),
        "paging": _pick(settings.get("paging"), PAGING, DEFAULT_SETTINGS["paging"]),
        "architecture": _pick(settings.get("architecture"), ARCHITECTURES, DEFAULT_SETTINGS["architecture"]),
        "verbs": _pick(settings.get("verbs"), VERBS, DEFAULT_SETTINGS["verbs"]),
        "tests": tests,
    }
