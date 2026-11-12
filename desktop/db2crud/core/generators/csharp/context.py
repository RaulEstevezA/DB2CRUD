"""What every file of a C# project needs to know about each table, computed once: the names of its classes, properties
and namespaces, its columns with their C# types, its key, the decisions of the review and the queries and operations
that are on. Mirrors web/src/core/generators/csharp/context.ts.

A column info is {"column", "prop", "local", "cs", "valueType", "optional", "propType", "generated", "required"}; a
table info holds the keys of TableInfo; the context is {"schema", "design", "settings", "tables", "base"}.
"""

import re

from ...crud.types import find_policy, find_repository, find_service
from .csharp import local_name, pascal_name

BLOCKING = (None, "no action", "restrict")


def cs_type(column_type: dict, database: str) -> tuple[str, bool]:
    """The C# type of a database value, and whether it is a value type."""
    kind = column_type["kind"]
    if kind == "integer":
        return {16: "short", 64: "long"}.get(column_type["bits"], "int"), True
    if kind == "decimal":
        return "decimal", True
    if kind == "float":
        return ("float" if column_type["bits"] == 32 else "double"), True
    if kind == "boolean":
        return "bool", True
    if kind == "date":
        return "DateOnly", True
    if kind == "time":
        # Npgsql reads a time with a time zone as a DateTimeOffset
        return ("DateTimeOffset" if column_type.get("timezone") and database == "postgresql" else "TimeOnly"), True
    if kind == "datetime":
        return ("DateTimeOffset" if column_type.get("timezone") else "DateTime"), True
    if kind == "uuid":
        return "Guid", True
    if kind == "binary":
        return "byte[]", False
    # JSON (and arrays, kept as JSON) as its text; enums as their value
    return "string", False


def _blocking_links(schema: dict, table: dict) -> list[dict]:
    return [
        {"table": other["name"], "columns": key["columns"], "references": key["references"]["columns"]}
        for other in schema["tables"]
        for key in other["foreignKeys"]
        if key["references"]["table"] == table["name"] and key.get("onDelete") in BLOCKING
    ]


def _included(items: list[dict]) -> list[dict]:
    return [item for item in items if item["include"]["value"]]


def _column_info(column: dict, entity: str, primary: bool, database: str) -> dict:
    generated = column.get("generated") is not None and column.get("generated") != "onUpdateNow"
    base = pascal_name(column["name"])
    # A member cannot have the name of its class
    prop = f"{base}Value" if base == entity else base
    cs, value_type = cs_type(column["type"], database)
    optional = not primary and (column["nullable"] or "default" in column or column.get("generated") is not None)
    return {
        "column": column,
        "prop": prop,
        "local": local_name(column["name"]),
        "cs": cs,
        "valueType": value_type,
        "optional": optional,
        "propType": f"{cs}?" if optional else cs,
        "generated": generated,
        "required": not column["nullable"] and "default" not in column and not generated,
    }


def _table_info(schema: dict, design: dict, settings: dict, table: dict) -> dict:
    policy = find_policy(design, table["name"])
    repository = find_repository(design, table["name"])
    service = find_service(design, table["name"]) if settings["services"] else None
    entity = pascal_name(repository["entity"])
    key_names = table["primaryKey"] or []
    columns = [
        _column_info(column, entity, column["name"] in key_names, settings["database"]) for column in table["columns"]
    ]

    def by_name(name: str) -> dict:
        return next(info for info in columns if info["column"]["name"] == name)

    # A table without a primary key is read only, keyless for EF Core; its rows are told apart by all their columns
    all_names = table["primaryKey"] if table["primaryKey"] is not None else [c["name"] for c in table["columns"]]
    delete_mode = policy["delete"]["value"]
    concurrency = policy["concurrency"]["value"]
    own_entities = not repository["entityMissing"] and schema["source"]["format"] == settings["orm"]
    writes_entity = settings["entities"] == "all" or (settings["entities"] == "missing" and not own_entities)
    folder = pascal_name(table["name"])
    children = policy["children"]
    return {
        "table": table,
        "name": table["name"],
        "entity": entity,
        "folder": f"{folder}Table" if folder == entity else folder,
        "attr": f"{folder}Rows" if folder == entity else folder,
        "columns": columns,
        "key": [by_name(name) for name in all_names],
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
        "base": "App",
    }


def writes_entities(context: dict) -> bool:
    return any(info["writesEntity"] for info in context["tables"])


def find_info(context: dict, table: str) -> dict | None:
    return next((info for info in context["tables"] if info["name"] == table), None)


def column_of(info: dict, name: str) -> dict:
    return next(column for column in info["columns"] if column["column"]["name"] == name)


def is_in(column: dict, columns: list[dict]) -> bool:
    return any(column is item for item in columns)


FOLDERS = {"entity": "Entities", "repository": "Repositories", "service": "Services", "dtos": "Dtos"}


def namespace_of(context: dict, info: dict, kind: str) -> str:
    """The namespace of one kind of class of a table: App.Repositories or App.Tables.OrderLines."""
    if kind == "entity" and not info["writesEntity"]:
        return context["settings"]["entitiesModule"]
    if context["settings"]["architecture"] == "table":
        return f"{context['base']}.Tables.{info['folder']}"
    return f"{context['base']}.{FOLDERS[kind]}"


def path_of(ns: str, name: str, test: bool = False) -> str:
    """The folder of a namespace, under src/App: App.Tables.OrderLines → src/App/Tables/OrderLines."""
    parts = ns.split(".")
    root = "tests/App.Tests" if test else "src/App"
    inner = parts[2:] if test else parts[1:]
    return "/".join([root, *inner, f"{name}.cs"])


def errors_namespace(context: dict) -> str:
    return f"{context['base']}.Errors"


def common_namespace(context: dict) -> str:
    return f"{context['base']}.Common"


def _read_name(context: dict, neutral: str, must_exist: bool) -> str:
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return re.sub(r"^(get|find)(?=[A-Z])", verb, neutral, count=1)


def _method(name: str) -> str:
    return f"{name[:1].upper()}{name[1:]}Async"


def query_name(context: dict, query_design: dict) -> str:
    """FindByIdAsync: the C# name of a repository query."""
    if query_design["kind"] in ("getByKey", "findByUnique"):
        return _method(_read_name(context, query_design["name"], False))
    return _method(query_design["name"])


def operation_name(context: dict, operation: dict) -> str:
    if operation["kind"] == "get":
        return _method(_read_name(context, operation["name"], True))
    if operation["kind"] == "find":
        return _method(_read_name(context, operation["name"], False))
    return _method(operation["name"])


def repository_interface(info: dict) -> str:
    return f"I{info['entity']}Repository"


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


def repository_type(context: dict, info: dict) -> str:
    return repository_interface(info) if context["settings"]["repositoryInterfaces"] else sql_repository_class(info)
