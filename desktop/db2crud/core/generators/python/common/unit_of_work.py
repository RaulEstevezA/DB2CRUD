"""app/unit_of_work.py: what services depend on, a repository per table and the transaction of each operation.
Mirrors web/src/core/generators/python/sqlalchemy/unitOfWork.ts."""

from ...types import lines
from ..python import Imports
from .context import memory_repository_class, module_of, repository_class, sql_repository_class

HOW = {
    "operation": "Each service operation runs in `transaction()`: committed when it ends, rolled back when it fails.",
    "caller": "Services never commit: whoever holds the session decides when the work is committed.",
    "repository": "Every repository write is committed at once; `transaction()` only groups the code.",
}


def unit_of_work_file(context: dict) -> dict:
    settings = context["settings"]
    is_async = context["async"]
    imports = Imports().from_("typing", "Protocol")
    tables = context["tables"]
    manager = "asynccontextmanager" if is_async else "contextmanager"
    iterator = "AsyncIterator" if is_async else "Iterator"
    manager_type = "AbstractAsyncContextManager" if is_async else "AbstractContextManager"
    imports.from_("contextlib", manager, manager_type).from_("collections.abc", iterator)
    for info in tables:
        module = module_of(context, info, "repository")
        imports.from_(module, sql_repository_class(info))
        if settings["repositoryInterfaces"]:
            imports.from_(module, repository_class(info))
        if settings["memoryRepositories"]:
            imports.from_(module, memory_repository_class(info))

    def type_of(info: dict) -> str:
        return repository_class(info) if settings["repositoryInterfaces"] else sql_repository_class(info)

    def_ = "async def" if is_async else "def"
    # Written before the imports, which it adds to
    database = context["orm"]["unitOfWork"](context, imports)
    content = lines(
        f'"""The repositories of every table, and the transaction of each service operation. {HOW[settings["transactions"]]}"""',
        "",
        imports.write("app"),
        "",
        "",
        "class UnitOfWork(Protocol):",
        '    """What services depend on: a repository per table and a transaction."""',
        "",
        *[f"    {info['attr']}: {type_of(info)}" for info in tables],
        "",
        f"    def transaction(self) -> {manager_type}[None]:",
        '        """Commits what runs inside it, or rolls it back if it fails."""',
        "        ...",
        "",
        "",
        *database,
        settings["memoryRepositories"]
        and [
            "",
            "",
            "class MemoryUnitOfWork:",
            '    """The in-memory repositories, for tests and for trying the services without a database."""',
            "",
            "    def __init__(self) -> None:",
            *[f"        self.{info['attr']} = {memory_repository_class(info)}()" for info in tables],
            "",
            f"    @{manager}",
            f"    {def_} transaction(self) -> {iterator}[None]:",
            '        """Memory has no transactions: changes are kept as they are made."""',
            "        yield",
        ],
        "",
    )
    return {"path": "app/unit_of_work.py", "content": content}
