"""src/unit-of-work.ts: what services depend on. It holds a repository per table and runs each operation in
transaction(work): the database one (written by each ORM) and the in-memory one over the memory repositories.
Mirrors web/src/core/generators/typescript/common/unitOfWork.ts."""

from ...types import lines
from ..typescript import TsImports
from .context import memory_repository_class, module_of, repository_interface, sql_repository_class

HOW = {
    "operation": "Each service operation runs in `transaction()`: committed when it ends, rolled back when it fails.",
    "caller": "Services never commit: whoever holds the connection decides when the work is committed; `transaction()` only groups the code.",
    "repository": "Every repository write is committed at once; `transaction()` only groups the code.",
}


def unit_of_work_file(context: dict) -> dict:
    settings = context["settings"]
    imports = TsImports("src/unit-of-work")
    interfaces = settings["repositoryInterfaces"]
    for info in context["tables"]:
        module = module_of(context, info, "repository")
        imports.from_(module, sql_repository_class(info))
        if interfaces:
            imports.type(module, repository_interface(info))
        if settings["memoryRepositories"]:
            imports.from_(module, memory_repository_class(info))

    # Without interfaces, the public methods of the database class: the in-memory class has the same ones
    def type_of(info: dict) -> str:
        if interfaces:
            return repository_interface(info)
        sql = sql_repository_class(info)
        return f"Pick<{sql}, keyof {sql}>" if settings["memoryRepositories"] else sql

    # Written before the imports, which it adds to
    database = context["orm"]["unitOfWork"](context, imports)
    content = lines(
        f"/** The repositories of every table, and the transaction of each service operation. {HOW[settings['transactions']]} */",
        imports.write(),
        "",
        "/** What services depend on: a repository per table and a transaction. */",
        "export interface UnitOfWork {",
        *(f"  readonly {info['attr']}: {type_of(info)}" for info in context["tables"]),
        "  /** Runs `work` with the repositories of the transaction; commits when it ends, rolls back when it throws. */",
        "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>",
        "}",
        "",
        *database,
        settings["memoryRepositories"]
        and [
            "",
            "/** The in-memory repositories, for tests and for trying the services without a database. */",
            "export class MemoryUnitOfWork implements UnitOfWork {",
            *(f"  readonly {info['attr']} = new {memory_repository_class(info)}()" for info in context["tables"]),
            "",
            "  /** Memory has no transactions: changes are kept as they are made. */",
            "  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {",
            "    return work(this)",
            "  }",
            "}",
        ],
        "",
    )
    return {"path": "src/unit-of-work.ts", "content": content}
