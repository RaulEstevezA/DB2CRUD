"""Python + SQLAlchemy 2 (Strategy of common/orm.py): the engine, sessions and declarative base, entities faithful to
the database, repositories with select(), a unit of work over one session, and tests on a real database. Mirrors
web/src/core/generators/python/sqlalchemy/index.ts."""

from ..common.context import sql_repository_class, writes_entities
from ..python import Imports
from .database import db_file, default_url, entity_files
from .repository import sql_body
from .tests import conftest_file, database_test

VERSIONS = {
    "sqlalchemy": "sqlalchemy>=2.0.36,<2.1",
    "psycopg": "psycopg[binary]>=3.2,<4",
    "pymysql": "pymysql>=1.1,<2",
    "cryptography": "cryptography>=43",
    "aiosqlite": "aiosqlite>=0.20,<1",
    "aiomysql": "aiomysql>=0.2,<1",
    "greenlet": "greenlet>=3.1",
    "pydantic": "pydantic>=2.9,<3",
    "pytest": "pytest>=8.3,<9",
    "pytestAsyncio": "pytest-asyncio>=0.24,<1",
}


def dependencies(context: dict) -> list[str]:
    settings = context["settings"]
    database = settings["database"]
    deps = [VERSIONS["sqlalchemy"]]
    if database == "postgresql":
        deps.append(VERSIONS["psycopg"])
    if database in ("mysql", "mariadb"):
        deps += [VERSIONS["pymysql"], VERSIONS["cryptography"]]
    if context["async"]:
        deps.append(VERSIONS["greenlet"])
        if database == "sqlite":
            deps.append(VERSIONS["aiosqlite"])
        if database in ("mysql", "mariadb"):
            deps.append(VERSIONS["aiomysql"])
    if settings["serviceTypes"] == "dtos" and settings["dtoKind"] == "pydantic":
        deps.append(VERSIONS["pydantic"])
    return deps


def dev_dependencies(context: dict) -> list[str]:
    # The tests run on SQLite unless TEST_DATABASE_URL names another database
    deps = [VERSIONS["pytest"]]
    if context["async"]:
        deps += [VERSIONS["pytestAsyncio"], VERSIONS["aiosqlite"]]
    return deps


def unit_of_work(context: dict, imports: Imports) -> list:
    """The class SqlUnitOfWork: the repositories over one session, and the transaction of each operation."""
    is_async = context["async"]
    settings = context["settings"]
    session_type = "AsyncSession" if is_async else "Session"
    imports.from_("sqlalchemy.ext.asyncio" if is_async else "sqlalchemy.orm", session_type)
    tables = context["tables"]
    manager = "asynccontextmanager" if is_async else "contextmanager"
    iterator = "AsyncIterator" if is_async else "Iterator"
    a = "await " if is_async else ""
    def_ = "async def" if is_async else "def"
    return [
        "class SqlUnitOfWork:",
        f'    """The repositories over one {session_type}."""',
        "",
        f"    def __init__(self, session: {session_type}) -> None:",
        "        self.session = session",
        *[f"        self.{info['attr']} = {sql_repository_class(info)}(session)" for info in tables],
        "",
        f"    @{manager}",
        f"    {def_} transaction(self) -> {iterator}[None]:",
        '        """Commits what runs inside it, or rolls it back if it fails."""',
        "        try:",
        "            yield",
        "        except BaseException:",
        f"            {a}self.session.rollback()",
        "            raise",
        f"        {a}self.session.commit()"
        if settings["transactions"] == "operation"
        else "        # The commit belongs to whoever holds the session",
    ]


def _doc(context: dict, info: dict) -> str:
    session = "AsyncSession" if context["async"] else "Session"
    commits = (
        " Every write is committed at once."
        if context["settings"]["transactions"] == "repository"
        else " It never commits: the transaction belongs to whoever holds the session."
    )
    return f"Keeps {info['name']} rows in the database, through a {session}.{commits}"


def _init(context: dict, imports: Imports) -> list:
    session = "AsyncSession" if context["async"] else "Session"
    imports.from_("sqlalchemy.ext.asyncio" if context["async"] else "sqlalchemy.orm", session)
    return [f"def __init__(self, session: {session}) -> None:", "    self._session = session"]


def _pytest_options(context: dict) -> list:
    return [
        context["async"] and 'asyncio_mode = "auto"',
        context["async"] and 'asyncio_default_fixture_loop_scope = "function"',
    ]


def _layout(context: dict) -> list[str]:
    base = " and the declarative base" if writes_entities(context) else ""
    return [f"app/db.py              engine, sessions{base}"]


SQLALCHEMY_ORM = {
    "id": "sqlalchemy",
    "label": "SQLAlchemy 2",
    "databaseFiles": lambda context: [db_file(context), *entity_files(context)],
    "repository": {"doc": _doc, "init": _init, "body": sql_body},
    "unitOfWork": unit_of_work,
    "conftest": conftest_file,
    "databaseTest": database_test,
    "databaseFixture": "sql_uow: SqlUnitOfWork",
    "dependencies": dependencies,
    "devDependencies": dev_dependencies,
    "pytestOptions": _pytest_options,
    "defaultUrl": default_url,
    "layout": _layout,
}
