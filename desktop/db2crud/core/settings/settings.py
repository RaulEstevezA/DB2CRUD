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
    },
    {
        "language": "typescript",
        "orm": "prisma",
        "label": "Prisma 7",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
    },
    {
        "language": "typescript",
        "orm": "drizzle",
        "label": "Drizzle 0.45",
        "databases": ["postgresql", "mysql", "mariadb", "sqlite"],
        "execution": ["async"],
        "errors": ["exceptions"],
        "dtoKinds": ["interface", "class"],
    },
]

DEFAULT_SETTINGS = {
    "name": "data-access",
    "language": "python",
    "orm": "sqlalchemy",
    "database": "postgresql",
    "entities": "missing",
    "entitiesModule": "app.entities",
    "services": True,
    "serviceTypes": "entities",
    "dtoKind": "pydantic",
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


def _module_path(value) -> str:
    valid = isinstance(value, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*", value)
    return value if valid else DEFAULT_SETTINGS["entitiesModule"]


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
        "entitiesModule": _module_path(settings.get("entitiesModule")),
        "services": services,
        "serviceTypes": _pick(settings.get("serviceTypes"), SERVICE_TYPES, DEFAULT_SETTINGS["serviceTypes"]),
        "dtoKind": _pick(settings.get("dtoKind"), stack["dtoKinds"], stack["dtoKinds"][0]),
        "transactions": _pick(settings.get("transactions"), TRANSACTIONS, DEFAULT_SETTINGS["transactions"]),
        "execution": _pick(settings.get("execution"), stack["execution"], stack["execution"][0]),
        "errors": _pick(settings.get("errors"), stack["errors"], stack["errors"][0]),
        "repositoryInterfaces": _bool(settings.get("repositoryInterfaces"), DEFAULT_SETTINGS["repositoryInterfaces"]),
        "memoryRepositories": _bool(settings.get("memoryRepositories"), DEFAULT_SETTINGS["memoryRepositories"]),
        "paging": _pick(settings.get("paging"), PAGING, DEFAULT_SETTINGS["paging"]),
        "architecture": _pick(settings.get("architecture"), ARCHITECTURES, DEFAULT_SETTINGS["architecture"]),
        "verbs": _pick(settings.get("verbs"), VERBS, DEFAULT_SETTINGS["verbs"]),
        "tests": tests,
    }
