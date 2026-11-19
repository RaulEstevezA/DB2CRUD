"""What every file of a Swift project needs to know about each table, computed once: the names of its types and
properties, the folder of its files, its columns with their Swift types, its key, the decisions of the review and the
queries and operations that are on. A Swift package is one module, so the folders only group files; every type name is
unique in it. Mirrors web/src/core/generators/swift/context.ts.

A column info is {"column", "prop", "key", "sw", "comparable", "generated", "required"}; a table info holds the keys of
TableInfo; the context is {"schema", "design", "settings", "tables", "module"}.
"""

import re

from ...crud.types import find_policy, find_repository, find_service
from .swift import member_name, type_name

BLOCKING = (None, "no action", "restrict")


def sw_type(column_type: dict) -> tuple[str, bool]:
    """The Swift type of a database value, and whether its values can be ordered with <."""
    kind = column_type["kind"]
    if kind == "integer":
        return "Int", True
    if kind == "decimal":
        return "Decimal", True
    if kind == "float":
        return ("Float" if column_type["bits"] == 32 else "Double"), True
    if kind == "boolean":
        return "Bool", False
    if kind in ("date", "datetime"):
        return "Date", True
    # Swift has no time of the day: TimeOfDay, in Common.swift
    if kind == "time":
        return "TimeOfDay", True
    if kind == "uuid":
        return "UUID", True
    if kind == "binary":
        # Data, which the drivers write as bytes (an array of UInt8 goes in as an array)
        return "Data", False
    # JSON (and arrays, kept as JSON) as its text; enums as their value; unknown types as their text
    return "String", True


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
    prop = member_name(column["name"])
    sw, comparable = sw_type(column["type"])
    return {
        "column": column,
        "prop": prop,
        "key": prop.replace("`", ""),
        "sw": sw,
        "comparable": comparable,
        "generated": generated,
        "required": not column["nullable"] and "default" not in column and not generated,
    }


def _table_info(schema: dict, design: dict, settings: dict, table: dict) -> dict:
    policy = find_policy(design, table["name"])
    repository = find_repository(design, table["name"])
    service = find_service(design, table["name"]) if settings["services"] else None
    entity = type_name(repository["entity"])
    columns = [_column_info(column) for column in table["columns"]]

    def by_name(name: str) -> dict:
        return next(info for info in columns if info["column"]["name"] == name)

    # A table without a primary key is read only; its rows are told apart by all their columns
    key_names = (
        table["primaryKey"] if table["primaryKey"] is not None else [column["name"] for column in table["columns"]]
    )
    delete_mode = policy["delete"]["value"]
    concurrency = policy["concurrency"]["value"]
    own_entities = not repository["entityMissing"] and schema["source"]["format"] == settings["orm"]
    writes_entity = settings["entities"] == "all" or (settings["entities"] == "missing" and not own_entities)
    children = policy["children"]
    return {
        "table": table,
        "name": table["name"],
        "entity": entity,
        "model": f"{entity}Model",
        "folder": type_name(table["name"]),
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


def create_context(schema: dict, design: dict, settings: dict) -> dict:
    return {
        "schema": schema,
        "design": design,
        "settings": settings,
        "tables": [_table_info(schema, design, settings, table) for table in schema["tables"]],
        "module": type_name(settings["name"]),
    }


def uses_times(context: dict) -> bool:
    """Whether a column of the project holds a time of the day."""
    return any(column["sw"] == "TimeOfDay" for info in context["tables"] for column in info["columns"])


def writes_entities(context: dict) -> bool:
    return any(info["writesEntity"] for info in context["tables"])


def find_info(context: dict, table: str) -> dict | None:
    return next((info for info in context["tables"] if info["name"] == table), None)


def column_of(info: dict, name: str) -> dict:
    return next(column for column in info["columns"] if column["column"]["name"] == name)


def is_in(column: dict, columns: list[dict]) -> bool:
    """Whether this very column is one of these (the same object, as the web version compares them)."""
    return any(column is item for item in columns)


def stored_type(column: dict) -> str:
    """The type of a value that is stored: ? only when the column takes null."""
    return f"{column['sw']}?" if column["column"]["nullable"] else column["sw"]


def stored(expression: str, column: dict) -> str:
    """The value of a property known to be set: entity.email!, or as it is when the column takes null."""
    return expression if column["column"]["nullable"] else f"{expression}!"


# Folders and names

LAYERS = {
    "entity": "Entities",
    "model": "Entities",
    "repository": "Repositories",
    "service": "Services",
    "dtos": "DTOs",
}


def file_of(context: dict, info: dict, kind: str, name: str) -> str:
    """The file of one kind of type of a table: Sources/DataAccess/Repositories/OrderLineRepository.swift."""
    folder = info["folder"] if context["settings"]["architecture"] == "table" else LAYERS[kind]
    return f"Sources/{context['module']}/{folder}/{name}.swift"


def shared_file(context: dict, name: str) -> str:
    """The file of a type the whole project shares: Sources/DataAccess/UnitOfWork.swift."""
    return f"Sources/{context['module']}/{name}.swift"


def _read_name(context: dict, neutral: str, must_exist: bool) -> str:
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return re.sub(r"^(get|find)(?=[A-Z])", verb, neutral, count=1)


def query_name(context: dict, query_design: dict) -> str:
    """findById: the Swift name of a repository query."""
    if query_design["kind"] in ("getByKey", "findByUnique"):
        return _read_name(context, query_design["name"], False)
    return query_design["name"]


def operation_name(context: dict, operation: dict) -> str:
    if operation["kind"] == "get":
        return _read_name(context, operation["name"], True)
    if operation["kind"] == "find":
        return _read_name(context, operation["name"], False)
    return operation["name"]


def repository_protocol(info: dict) -> str:
    return f"{info['entity']}Repository"


def sql_repository(info: dict) -> str:
    return f"Sql{info['entity']}Repository"


def memory_repository(info: dict) -> str:
    return f"Memory{info['entity']}Repository"


def service_type(info: dict) -> str:
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
    """The type a repository is used through: its protocol, or the database class when there are none."""
    return f"any {repository_protocol(info)}" if context["settings"]["repositoryInterfaces"] else sql_repository(info)


def key_type(info: dict) -> str:
    """The type of a table's key: Int, or a tuple when it has several columns."""
    if len(info["key"]) == 1:
        return info["key"][0]["sw"]
    return f"({', '.join(column['key'] + ': ' + column['sw'] for column in info['key'])})"


def sw_file(path: str, header: str, body: list) -> dict:
    """The file of a Swift source: its imports and body (None and False lines are left out)."""
    content = [*([header, ""] if header != "" else []), *body, ""]
    return {"path": path, "content": "\n".join(line for line in content if isinstance(line, str))}


def ind(items: list[str], spaces: int = 4) -> list[str]:
    """Indents the lines that apply."""
    return ["" if line == "" else " " * spaces + line for line in items]
