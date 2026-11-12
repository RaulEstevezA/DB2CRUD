"""What every file of a TypeScript project needs to know about each table, computed once: the names of its classes,
properties and modules, its columns with their TypeScript types, its key, the decisions of the review and the
queries and operations that are on. Mirrors web/src/core/generators/typescript/common/context.ts.

A column info is {"column", "prop", "ts", "generated", "required"}; a table info holds the keys of TableInfo; the
context is {"orm", "schema", "design", "settings", "tables"}.
"""

import re

from ....crud.types import find_policy, find_repository, find_service
from ..typescript import file_name, member_name, type_name

BLOCKING = (None, "no action", "restrict")


def ts_type(column_type: dict) -> str:
    """The TypeScript type of a database value as the drivers return it: exact decimals and dates without a time stay
    text, so nothing is rounded or moved to another time zone."""
    kind = column_type["kind"]
    if kind in ("integer", "float"):
        return "number"
    if kind in ("decimal", "text", "enum", "date", "time", "uuid"):
        return "string"
    if kind == "boolean":
        return "boolean"
    if kind == "datetime":
        return "Date"
    if kind == "binary":
        return "Buffer"
    if kind == "array":
        return f"{ts_type(column_type['items'])}[]"
    return "unknown"


def column_type(info: dict, optional: bool | None = None) -> str:
    """The type of a column, `| null` when it is nullable (or `optional` says so)."""
    nullable = info["column"]["nullable"] if optional is None else optional
    return f"{info['ts']} | null" if nullable else info["ts"]


def _blocking_links(schema: dict, table: dict) -> list[dict]:
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
        "prop": member_name(column["name"]),
        "ts": ts_type(column["type"]),
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

    # A table without a primary key is mapped on all its columns: ORMs need some key to tell rows apart
    key_names = (
        table["primaryKey"] if table["primaryKey"] is not None else [column["name"] for column in table["columns"]]
    )
    delete_mode = policy["delete"]["value"]
    concurrency = policy["concurrency"]["value"]
    # The input's classes only count when they are of this stack's ORM
    own_entities = not repository["entityMissing"] and schema["source"]["format"] == settings["orm"]
    writes_entity = settings["entities"] == "all" or (settings["entities"] == "missing" and not own_entities)
    children = policy["children"]
    return {
        "table": table,
        "name": table["name"],
        "entity": type_name(repository["entity"]),
        "file": file_name(repository["entity"]),
        "attr": member_name(table["name"]),
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


def create_context(orm: dict, schema: dict, design: dict, settings: dict) -> dict:
    return {
        "orm": orm,
        "schema": schema,
        "design": design,
        "settings": settings,
        "tables": [_table_info(schema, design, settings, table) for table in schema["tables"]],
    }


def writes_entities(context: dict) -> bool:
    return any(info["writesEntity"] for info in context["tables"])


def find_info(context: dict, table: str) -> dict | None:
    return next((info for info in context["tables"] if info["name"] == table), None)


def column_of(info: dict, name: str) -> dict:
    return next(column for column in info["columns"] if column["column"]["name"] == name)


def is_in(column: dict, columns: list[dict]) -> bool:
    """Whether this very column is one of these (the same object, as the web version compares them)."""
    return any(column is item for item in columns)


# Modules and names


def module_of(context: dict, info: dict, kind: str) -> str:
    """Module path (without extension) of one kind of file of a table: src/repositories/order-line or
    src/order-line/repository."""
    # Entities the project does not write are imported from the module the settings name (dots become slashes);
    # plain entities are always written: the setting decides on the ORM's own tables
    if kind == "entity" and not info["writesEntity"] and not context["orm"]["plainEntities"]:
        return context["settings"]["entitiesModule"].replace(".", "/")
    if context["settings"]["architecture"] == "table":
        return f"src/{info['file']}/{kind}"
    folder = {"entity": "entities", "repository": "repositories", "service": "services", "dtos": "dtos"}[kind]
    return f"src/{folder}/{info['file']}"


def path_of(module: str) -> str:
    return f"{module}.ts"


def _read_name(context: dict, neutral: str, must_exist: bool) -> str:
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return re.sub(r"^(get|find)(?=[A-Z])", verb, neutral, count=1)


def query_name(context: dict, query_design: dict) -> str:
    """TypeScript name of a repository query: the neutral name, with the verb the settings choose for single reads."""
    if query_design["kind"] in ("getByKey", "findByUnique"):
        return _read_name(context, query_design["name"], False)
    return query_design["name"]


def operation_name(context: dict, operation: dict) -> str:
    if operation["kind"] == "get":
        return _read_name(context, operation["name"], True)
    if operation["kind"] == "find":
        return _read_name(context, operation["name"], False)
    return operation["name"]


def repository_interface(info: dict) -> str:
    return f"{info['entity']}Repository"


def sql_repository_class(info: dict) -> str:
    return f"Sql{info['entity']}Repository"


def memory_repository_class(info: dict) -> str:
    return f"Memory{info['entity']}Repository"


def service_class(info: dict) -> str:
    return f"{info['entity']}Service"


def query(info: dict, kind: str, columns: list[str] | None = None) -> dict | None:
    return next(
        (
            item
            for item in info["queries"]
            if item["kind"] == kind and (columns is None or ",".join(item["columns"]) == ",".join(columns))
        ),
        None,
    )
