"""The technology choices of a generated project (framework, architecture, persistence, database and
authentication) and the matrix of which ones work together. Only combinations a generator really writes are
offered. Mirrors web/src/core/compatibility/stack.ts.

Settings are a dictionary: {"name", "framework", "architecture", "persistence", "database", "auth",
"defaultAccess", "javaPackage"}.
"""

import re

from ..js import trim

# Every framework, in the order the interface shows them
FRAMEWORKS: tuple[dict, ...] = (
    {
        "id": "fastapi",
        "label": "FastAPI",
        "language": "python",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "sqlalchemy", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "djangoRest",
        "label": "Django REST Framework",
        "language": "python",
        "architectures": ("layered", "modular"),
        "persistence": ({"id": "djangoOrm", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "express",
        "label": "Express",
        "language": "typescript",
        "architectures": ("layered", "modular"),
        "persistence": ({"id": "memory", "databases": ()}, {"id": "none", "databases": ()}),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "nestjs",
        "label": "NestJS",
        "language": "typescript",
        "architectures": ("modular",),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "typeorm", "databases": ("postgresql", "mysql", "mariadb")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "springBoot",
        "label": "Spring Boot",
        "language": "java",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "jpa", "databases": ("postgresql", "mysql", "mariadb")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "laravel",
        "label": "Laravel",
        "language": "php",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "eloquent", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "symfony",
        "label": "Symfony",
        "language": "php",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "doctrine", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "aspnetCore",
        "label": "ASP.NET Core",
        "language": "csharp",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "efCore", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "ktor",
        "label": "Ktor",
        "language": "kotlin",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "exposed", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "axum",
        "label": "Axum",
        "language": "rust",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "seaOrm", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
    {
        "id": "vapor",
        "label": "Vapor",
        "language": "swift",
        "architectures": ("layered", "modular"),
        "persistence": (
            {"id": "memory", "databases": ()},
            {"id": "none", "databases": ()},
            {"id": "fluent", "databases": ("postgresql", "mysql", "mariadb", "sqlite")},
        ),
        "auth": ("none", "apiKey", "jwt"),
    },
)

DEFAULT_SETTINGS = {
    "name": "api",
    "framework": "fastapi",
    "architecture": "layered",
    "persistence": "memory",
    "database": None,
    "auth": "none",
    "defaultAccess": "authenticated",
    "javaPackage": "com.example.api",
}


def find_framework(framework_id: str) -> dict:
    return next((framework for framework in FRAMEWORKS if framework["id"] == framework_id), FRAMEWORKS[0])


def databases_for(framework_id: str, persistence: str) -> tuple[str, ...]:
    """The databases a persistence of a framework supports; empty when it needs none."""
    option = next((item for item in find_framework(framework_id)["persistence"] if item["id"] == persistence), None)
    return option["databases"] if option else ()


_JAVA_PACKAGE = re.compile(r"^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$")
_MISSING = object()


def normalize_settings(settings: dict) -> dict:
    """Makes settings consistent with the matrix: an option the framework does not offer becomes its first
    offered option, and the database follows the persistence. Every other value is kept."""
    framework = find_framework(settings.get("framework"))
    architecture = (
        settings.get("architecture")
        if settings.get("architecture") in framework["architectures"]
        else framework["architectures"][0]
    )
    offered = [item["id"] for item in framework["persistence"]]
    persistence = settings.get("persistence") if settings.get("persistence") in offered else offered[0]
    databases = databases_for(framework["id"], persistence)
    chosen = settings.get("database")
    database = None if not databases else chosen if chosen and chosen in databases else databases[0]
    auth = settings.get("auth") if settings.get("auth") in framework["auth"] else framework["auth"][0]
    name = slug(settings.get("name") or "") or DEFAULT_SETTINGS["name"]
    package = settings.get("javaPackage", _MISSING)
    # As on the web, a package that is missing or null is tested as the text "undefined" or "null", and kept
    valid = package is _MISSING or package is None or (isinstance(package, str) and _JAVA_PACKAGE.match(package))
    result = {
        **settings,
        "framework": framework["id"],
        "architecture": architecture,
        "persistence": persistence,
        "database": database,
        "auth": auth,
        "name": name,
    }
    if package is not _MISSING:
        result["javaPackage"] = package if valid else DEFAULT_SETTINGS["javaPackage"]
    return result


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_NOT_SLUG = re.compile(r"[^a-z0-9]+")
_EDGE_HYPHENS = re.compile(r"^-+|-+$")


def slug(text: str) -> str:
    """A project name usable as a folder and package name: lower case words joined by hyphens."""
    return _EDGE_HYPHENS.sub("", _NOT_SLUG.sub("-", _CAMEL.sub(r"\1-\2", trim(text)).lower()))
