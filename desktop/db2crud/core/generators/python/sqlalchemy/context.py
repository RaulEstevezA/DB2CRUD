"""What every file of a SQLAlchemy project needs to know about each table, computed once: the names of its classes
and modules, its columns with their Python types, its key, the decisions of the review and the queries and operations
that are on. Mirrors web/src/core/generators/python/sqlalchemy/context.ts.

A column info is {"column", "attr", "py", "generated", "required"}; a table info holds the keys of TableInfo; the
context is {"schema", "design", "settings", "tables", "async"}.
"""

import re

from ....crud.types import find_policy, find_repository, find_service
from ..python import Imports, class_name, method_name, snake_name

BLOCKING = (None, "no action", "restrict")


def _py_type(column_type: dict, imports: Imports | None = None) -> str:
    kind = column_type["kind"]
    simple = {"integer": "int", "float": "float", "text": "str", "enum": "str", "boolean": "bool", "binary": "bytes"}
    if kind in simple:
        return simple[kind]
    imported = {
        "decimal": ("decimal", "Decimal"),
        "date": ("datetime", "date"),
        "time": ("datetime", "time"),
        "datetime": ("datetime", "datetime"),
        "uuid": ("uuid", "UUID"),
    }
    if kind in imported:
        module, name = imported[kind]
        if imports is not None:
            imports.from_(module, name)
        return name
    if kind == "array":
        return f"list[{_py_type(column_type['items'], imports)}]"
    if imports is not None:
        imports.from_("typing", "Any")
    return "Any"


def column_py_type(info: dict, imports: Imports, optional: bool | None = None) -> str:
    """The Python type of a column, adding its imports."""
    base = _py_type(info["column"]["type"], imports)
    nullable = info["column"]["nullable"] if optional is None else optional
    return f"{base} | None" if nullable else base


def _blocking_links(schema: dict, table: dict) -> list[dict]:
    """Foreign keys of other tables to this one that leave their rows in place when it is deleted."""
    return [
        {"table": other["name"], "columns": key["columns"], "references": key["references"]["columns"]}
        for other in schema["tables"]
        for key in other["foreignKeys"]
        if key["references"]["table"] == table["name"] and key.get("onDelete") in BLOCKING
    ]


def _included(items: list[dict]) -> list[dict]:
    return [item for item in items if item["include"]["value"]]


def _column_info(column: dict) -> dict:
    generated = column.get("generated") is not None and column.get("generated") != "onUpdateNow"
    return {
        "column": column,
        "attr": snake_name(column["name"]),
        "py": _py_type(column["type"]),
        "generated": generated,
        "required": not column["nullable"] and "default" not in column and not generated,
    }


def _table_info(schema: dict, design: dict, settings: dict, table: dict) -> dict:
    policy = find_policy(design, table["name"])
    repository = find_repository(design, table["name"])
    service = find_service(design, table["name"]) if settings["services"] else None
    columns = [_column_info(column) for column in table["columns"]]

    def by_name(name: str) -> dict:
        return next(info for info in columns if info["column"]["name"] == name)

    # A table without a primary key is mapped on all its columns: SQLAlchemy needs some key to map rows
    key_names = (
        table["primaryKey"] if table["primaryKey"] is not None else [column["name"] for column in table["columns"]]
    )
    delete_mode = policy["delete"]["value"]
    concurrency = policy["concurrency"]["value"]
    # The input's classes only count when they are of this stack's ORM: JPA entities do not help a SQLAlchemy project
    own_entities = not repository["entityMissing"] and schema["source"]["format"] == settings["orm"]
    writes_entity = settings["entities"] == "all" or (settings["entities"] == "missing" and not own_entities)
    children = policy["children"]
    return {
        "table": table,
        "name": table["name"],
        "entity": class_name(repository["entity"]),
        "module": snake_name(repository["entity"]),
        "attr": snake_name(table["name"]),
        "columns": columns,
        "key": [by_name(name) for name in key_names],
        "role": policy["role"]["value"],
        "soft": by_name(delete_mode["column"]) if delete_mode["mode"] == "soft" else None,
        "version": by_name(concurrency["column"]) if concurrency["mode"] == "version" else None,
        "hidden": policy["hidden"]["value"],
        "children": {"policy": children["value"], "links": _blocking_links(schema, table)} if children else None,
        "queries": _included(repository["queries"]),
        "operations": _included(service["operations"]) if service else [],
        "repository": repository,
        "service": service,
        "writesEntity": writes_entity,
    }


def create_context(schema: dict, design: dict, settings: dict) -> dict:
    return {
        "schema": schema,
        "design": design,
        "settings": settings,
        "tables": [_table_info(schema, design, settings, table) for table in schema["tables"]],
        "async": settings["execution"] == "async",
    }


def find_info(context: dict, table: str) -> dict | None:
    return next((info for info in context["tables"] if info["name"] == table), None)


def is_in(column: dict, columns: list[dict]) -> bool:
    """Whether this very column is one of these (the same object, as the web version compares them)."""
    return any(column is item for item in columns)


# Modules and names


def module_of(context: dict, info: dict, kind: str) -> str:
    """Module of one kind of file of a table, by architecture: app.repositories.order_line or app.order_line.repository."""
    if kind == "entity" and not info["writesEntity"]:
        return context["settings"]["entitiesModule"]
    if context["settings"]["architecture"] == "table":
        return f"app.{info['module']}.{kind}"
    folder = {"entity": "entities", "repository": "repositories", "service": "services", "dtos": "dtos"}[kind]
    return f"app.{folder}.{info['module']}"


def path_of(module: str) -> str:
    return module.replace(".", "/") + ".py"


def read_name(context: dict, neutral: str, must_exist: bool) -> str:
    """A read that returns one row or none: find_by_email, or get_by_email, as the settings name them."""
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return method_name(re.sub(r"^(get|find)(?=[A-Z])", verb, neutral))


def query_name(context: dict, query: dict) -> str:
    if query["kind"] in ("getByKey", "findByUnique"):
        return read_name(context, query["name"], False)
    return method_name(query["name"])


def operation_name(context: dict, operation: dict) -> str:
    if operation["kind"] == "get":
        return read_name(context, operation["name"], True)
    if operation["kind"] == "find":
        return read_name(context, operation["name"], False)
    return method_name(operation["name"])


def repository_class(info: dict) -> str:
    return f"{info['entity']}Repository"


def sql_repository_class(info: dict) -> str:
    return f"Sql{info['entity']}Repository"


def memory_repository_class(info: dict) -> str:
    return f"Memory{info['entity']}Repository"


def service_class(info: dict) -> str:
    return f"{info['entity']}Service"


def query(info: dict, kind: str, columns: list[str] | None = None) -> dict | None:
    """The query of a kind, when it is on."""
    return next(
        (
            item
            for item in info["queries"]
            if item["kind"] == kind and (columns is None or ",".join(item["columns"]) == ",".join(columns))
        ),
        None,
    )


def aw(context: dict) -> str:
    return "await " if context["async"] else ""


def def_(context: dict) -> str:
    return "async def" if context["async"] else "def"
