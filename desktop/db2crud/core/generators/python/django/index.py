"""Python + Django 5.2 ORM (Strategy of common/orm.py). Mirrors web/src/core/generators/python/django/index.ts."""

from ...types import lines
from ..common.context import sql_repository_class, writes_entities
from ..python import Imports
from .database import database_files, default_url

VERSIONS = {
    "django": "django>=5.2,<5.3",
    "psycopg": "psycopg[binary]>=3.2,<4",
    "pymysql": "pymysql>=1.1,<2",
    "cryptography": "cryptography>=43",
    "pydantic": "pydantic>=2.9,<3",
    "pytest": "pytest>=8.3,<9",
    "pytestDjango": "pytest-django>=4.9,<5",
}


def dependencies(context: dict) -> list[str]:
    settings = context["settings"]
    deps = [VERSIONS["django"]]
    if settings["database"] == "postgresql":
        deps.append(VERSIONS["psycopg"])
    if settings["database"] in ("mysql", "mariadb"):
        deps += [VERSIONS["pymysql"], VERSIONS["cryptography"]]
    if settings["serviceTypes"] == "dtos" and settings["dtoKind"] == "pydantic":
        deps.append(VERSIONS["pydantic"])
    return deps


# Repositories


def _soft_lookup(info: dict) -> str | None:
    soft = info["soft"]
    if not soft:
        return None
    return f"{soft['attr']}=False" if soft["column"]["type"]["kind"] == "boolean" else f"{soft['attr']}__isnull=True"


def _key_order(info: dict) -> str:
    return ", ".join(f'"{column["attr"]}"' for column in info["key"])


def _filter(info: dict, lookups: list[str]) -> str:
    every = [item for item in [*lookups, _soft_lookup(info)] if item is not None]
    return f".filter({', '.join(every)})" if every else ".all()"


def _after(info: dict) -> str:
    """Rows after a key, in key order: a > x OR (a = x AND b > y)."""
    keys = [column["attr"] for column in info["key"]]
    terms = []
    for index, key in enumerate(keys):
        equal = [f"{previous}=after[{position}]" for position, previous in enumerate(keys[:index])]
        terms.append(f"Q({', '.join([*equal, f'{key}__gt=after[{index}]'])})")
    return " | ".join(terms)


def body(context: dict, info: dict, method: dict, imports: Imports) -> list:
    entity = info["entity"]
    equals = [f"{param['name']}={param['name']}" for param in method["params"]]
    objects = f"{entity}.objects"

    def write(action: str, refresh: bool) -> list:
        imports.from_("django.db", "IntegrityError", "transaction").from_("app.errors", "ConflictError")
        return [
            "try:",
            "    with transaction.atomic():",
            f"        {action}",
            "except IntegrityError as error:",
            f'    raise ConflictError("{entity}", "the database refused the change: " + str(error)) from error',
            # Values the database fills (db_default) are read back, so a later read gives the same row
            refresh and "entity.refresh_from_db()",
        ]

    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return {objects}{_filter(info, equals)}.first()"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return list({objects}{_filter(info, equals)}.order_by({_key_order(info)}))"]
    if kind == "list":
        base = f"query = {objects}{_filter(info, [])}.order_by({_key_order(info)})"
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                base,
                "total = query.count()",
                "return Page(items=list(query[offset : offset + limit]), total=total, offset=offset, limit=limit)",
            ]
        if paging == "cursor":
            imports.from_("django.db.models", "Q")
            last = ", ".join(f"rows[-1].{column['attr']}" for column in info["key"])
            return [
                base,
                "if after is not None:",
                f"    query = query.filter({_after(info)})",
                "rows = list(query[: limit + 1])",
                "more = len(rows) > limit",
                "rows = rows[:limit]",
                f"last = ({last},) if more else None",
                "return CursorPage(items=rows, next=last)",
            ]
        return [base, "return list(query)"]
    if kind == "insert":
        return [*write("entity.save(force_insert=True)", True), "return entity"]
    if kind == "update":
        return [*write("entity.save()", True), "return entity"]
    if kind == "delete":
        return write("entity.delete()", False)
    return ["raise NotImplementedError"]


# Unit of work


def unit_of_work(context: dict, imports: Imports) -> list:
    imports.from_("contextlib", "contextmanager").from_("collections.abc", "Iterator")
    operation = context["settings"]["transactions"] == "operation"
    if operation:
        imports.from_("django.db", "transaction")
    transaction_lines = (
        [
            '        """Commits what runs inside it, or rolls it back if it fails (transaction.atomic)."""',
            "        with transaction.atomic():",
            "            yield",
        ]
        if operation
        else [
            '        """Groups the code: the transaction belongs to whoever calls the services, or to each write."""',
            "        yield",
        ]
    )
    return [
        "class SqlUnitOfWork:",
        '    """The repositories over the Django database connection."""',
        "",
        "    def __init__(self) -> None:",
        *[f"        self.{info['attr']} = {sql_repository_class(info)}()" for info in context["tables"]],
        "",
        "    @contextmanager",
        "    def transaction(self) -> Iterator[None]:",
        *transaction_lines,
    ]


# Tests


def conftest(context: dict) -> dict:
    imports = Imports().module("pytest").from_("app.unit_of_work", "SqlUnitOfWork")
    if context["settings"]["memoryRepositories"]:
        imports.from_("app.unit_of_work", "MemoryUnitOfWork")
    content = lines(
        '"""Fixtures of the tests: the test database pytest-django creates from the models, and the units of work."""',
        "",
        imports.write("app"),
        "",
        "",
        "@pytest.fixture",
        "def sql_uow(db) -> SqlUnitOfWork:  # type: ignore[no-untyped-def]",
        '    """The repositories over the test database; every test runs in a transaction rolled back after it."""',
        "    return SqlUnitOfWork()",
        context["settings"]["memoryRepositories"]
        and [
            "",
            "",
            "@pytest.fixture",
            "def memory_uow() -> MemoryUnitOfWork:",
            '    """The in-memory repositories."""',
            "    return MemoryUnitOfWork()",
        ],
        "",
    )
    return {"path": "tests/conftest.py", "content": content}


def test_settings(_context: dict) -> list[dict]:
    content = lines(
        '"""Settings of the tests: the project\'s, on TEST_DATABASE_URL, or SQLite in memory (pytest-django creates the',
        'test database from the models and empties it)."""',
        "",
        "import os",
        "",
        "from app.settings import *  # noqa: F403",
        "from app.settings import database_from_url",
        "",
        'DATABASES = {"default": database_from_url(os.environ.get("TEST_DATABASE_URL") or "sqlite://:memory:")}',
        "",
    )
    return [{"path": "tests/settings.py", "content": content}]


def database_test(_context: dict) -> dict:
    content = lines(
        '"""The tests run on the database they were asked to."""',
        "",
        "import os",
        "",
        "from django.db import connection",
        "",
        "",
        "def test_runs_on_the_database_asked(db) -> None:  # type: ignore[no-untyped-def]",
        '    url = os.environ.get("TEST_DATABASE_URL")',
        '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
        "    # Django runs MariaDB with its MySQL backend",
        '    assert connection.vendor == ("mysql" if expected == "mariadb" else expected)',
        "",
    )
    return {"path": "tests/test_database.py", "content": content}


def _doc(context: dict, info: dict) -> str:
    joins = (
        " Its writes join the transaction of the operation."
        if context["settings"]["transactions"] == "operation"
        else ""
    )
    return f"Keeps {info['name']} rows in the database, through the {info['entity']} model.{joins}"


def _unset(target: str, imports: Imports) -> str:
    # A field with db_default holds a DatabaseDefault until the row is stored
    imports.from_("django.db.models.expressions", "DatabaseDefault")
    return f"{target} is None or isinstance({target}, DatabaseDefault)"


def _layout(context: dict) -> list[str]:
    result = ["app/settings.py        Django settings: the database comes from DATABASE_URL"]
    if writes_entities(context):
        result.append("app/models.py          imports every entity, for Django's app registry")
    return result


DJANGO_ORM = {
    "id": "django",
    "label": "the Django 5.2 ORM",
    "databaseFiles": database_files,
    "repository": {"doc": _doc, "init": lambda _context, _imports: [], "body": body},
    "unset": _unset,
    "unitOfWork": unit_of_work,
    "conftest": conftest,
    "databaseTest": database_test,
    "extraTestFiles": test_settings,
    "databaseFixture": "sql_uow: SqlUnitOfWork",
    "dependencies": dependencies,
    "devDependencies": lambda _context: [VERSIONS["pytest"], VERSIONS["pytestDjango"]],
    "pytestOptions": lambda _context: ['DJANGO_SETTINGS_MODULE = "tests.settings"'],
    "defaultUrl": default_url,
    "layout": _layout,
}
