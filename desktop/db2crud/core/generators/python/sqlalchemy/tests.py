"""The fixtures of a SQLAlchemy project's tests, and the test that proves which database they ran on. Mirrors
web/src/core/generators/python/sqlalchemy/tests.ts."""

from ...types import lines
from ..common.context import module_of
from ..python import Imports


def _def(context: dict) -> str:
    return "async def" if context["async"] else "def"


def conftest_file(context: dict) -> dict:
    imports = Imports().module("os").module("pytest")
    imports.from_("app.db", "Base", "create_db_engine", "create_session_factory").from_(
        "app.unit_of_work", "SqlUnitOfWork"
    )
    if context["settings"]["memoryRepositories"]:
        imports.from_("app.unit_of_work", "MemoryUnitOfWork")
    for info in context["tables"]:
        if info["writesEntity"]:
            imports.from_(module_of(context, info, "entity"), info["entity"])
    is_async = context["async"]
    if is_async:
        imports.module("pytest_asyncio").from_("collections.abc", "AsyncIterator")
    else:
        imports.from_("collections.abc", "Iterator")
    fixture = "@pytest_asyncio.fixture" if is_async else "@pytest.fixture"
    content = lines(
        '"""Fixtures of the tests: a database created from the entities, and the units of work."""',
        "",
        imports.write("app"),
        "",
        "# Every entity is imported above, so the metadata knows every table",
        "",
        "",
        fixture,
        "async def engine(tmp_path):  # type: ignore[no-untyped-def]"
        if is_async
        else "def engine(tmp_path):  # type: ignore[no-untyped-def]",
        '    """The test database, empty: TEST_DATABASE_URL, or SQLite in a temporary file."""',
        '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
        "    engine = create_db_engine(url)",
        [
            "    async with engine.begin() as connection:",
            "        await connection.run_sync(Base.metadata.drop_all)",
            "        await connection.run_sync(Base.metadata.create_all)",
            "    yield engine",
            "    async with engine.begin() as connection:",
            "        await connection.run_sync(Base.metadata.drop_all)",
            "    await engine.dispose()",
        ]
        if is_async
        else [
            "    Base.metadata.drop_all(engine)",
            "    Base.metadata.create_all(engine)",
            "    yield engine",
            "    Base.metadata.drop_all(engine)",
            "    engine.dispose()",
        ],
        "",
        "",
        fixture,
        "async def sql_uow(engine) -> AsyncIterator[SqlUnitOfWork]:  # type: ignore[no-untyped-def]"
        if is_async
        else "def sql_uow(engine) -> Iterator[SqlUnitOfWork]:  # type: ignore[no-untyped-def]",
        '    """The repositories over a session of the test database."""',
        ["    async with create_session_factory(engine)() as session:", "        yield SqlUnitOfWork(session)"]
        if is_async
        else ["    with create_session_factory(engine)() as session:", "        yield SqlUnitOfWork(session)"],
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


def database_test(context: dict) -> dict:
    """Fails when the tests do not run on the database TEST_DATABASE_URL names."""
    return {
        "path": "tests/test_database.py",
        "content": lines(
            '"""The tests run on the database they were asked to."""',
            "",
            "import os",
            "",
            "",
            f"{_def(context)} test_runs_on_the_database_asked(engine) -> None:  # type: ignore[no-untyped-def]",
            '    url = os.environ.get("TEST_DATABASE_URL")',
            '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
            "    assert engine.dialect.name == expected",
            "",
        ),
    }
