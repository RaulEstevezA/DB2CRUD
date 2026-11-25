"""What every file of a PHP project needs to know about each table, computed once: the names of its classes,
properties and namespaces, its columns with their PHP types, its key, the decisions of the review and the queries and
operations that are on. Mirrors web/src/core/generators/php/common/context.ts.

A column info is {"column", "prop", "field", "php", "generated", "required"}; a table info holds the keys of TableInfo;
the context is {"orm", "schema", "design", "settings", "tables", "base"}.
"""

import re

from ....crud.types import find_policy, find_repository, find_service
from .php import field_name, nullable, pascal_name

BLOCKING = (None, "no action", "restrict")


def _blocking_links(schema: dict, table: dict) -> list[dict]:
    return [
        {"table": other["name"], "columns": key["columns"], "references": key["references"]["columns"]}
        for other in schema["tables"]
        for key in other["foreignKeys"]
        if key["references"]["table"] == table["name"] and key.get("onDelete") in BLOCKING
    ]


def _included(items: list[dict]) -> list[dict]:
    return [item for item in items if item["include"]["value"]]


def _is_date_key(schema: dict, table: dict, name: str, seen: set[str] | None = None) -> bool:
    """Whether a column is a date in the key of its table, or points to one (through other tables too)."""
    seen = set() if seen is None else seen
    column = next((item for item in table["columns"] if item["name"] == name), None)
    if not column or column["type"]["kind"] not in ("date", "time", "datetime"):
        return False
    if name in (table["primaryKey"] or []):
        return True
    path = f"{table['name']}.{name}"
    if path in seen:
        return False
    seen.add(path)
    for key in table["foreignKeys"]:
        if name not in key["columns"]:
            continue
        parent = next((item for item in schema["tables"] if item["name"] == key["references"]["table"]), None)
        if parent and _is_date_key(schema, parent, key["references"]["columns"][key["columns"].index(name)], seen):
            return True
    return False


def _column_info(orm: dict, schema: dict, table: dict, column: dict) -> dict:
    generated = column.get("generated") is not None and column.get("generated") != "onUpdateNow"
    # MongoDB's `_id` is the `id` of the entity, unless the documents have one of their own
    own = (
        bool(orm.get("documents"))
        and column["name"] == "_id"
        and any(item["name"] == "id" for item in table["columns"])
    )
    return {
        "column": column,
        "prop": "documentId" if own else orm["property"](column),
        "field": "documentId" if own else field_name(column["name"]),
        "php": "string"
        if orm.get("textDateKeys") and _is_date_key(schema, table, column["name"])
        else orm["phpType"](column["type"]),
        "generated": generated,
        "required": not column["nullable"] and "default" not in column and not generated,
    }


def _table_info(orm: dict, schema: dict, design: dict, settings: dict, table: dict) -> dict:
    policy = find_policy(design, table["name"])
    repository = find_repository(design, table["name"])
    service = find_service(design, table["name"]) if settings["services"] else None
    entity = pascal_name(repository["entity"])
    columns = [_column_info(orm, schema, table, column) for column in table["columns"]]

    def by_name(name: str) -> dict:
        return next(info for info in columns if info["column"]["name"] == name)

    # A table without a primary key is read only; its rows are told apart by all their columns
    key_names = table["primaryKey"] if table["primaryKey"] is not None else [c["name"] for c in table["columns"]]
    delete_mode = policy["delete"]["value"]
    concurrency = policy["concurrency"]["value"]
    own_entities = (
        not orm.get("documents") and not repository["entityMissing"] and schema["source"]["format"] == settings["orm"]
    )
    writes_entity = settings["entities"] == "all" or (settings["entities"] == "missing" and not own_entities)
    folder = pascal_name(table["name"])
    children = policy["children"]
    return {
        "table": table,
        "name": table["name"],
        "entity": entity,
        "folder": f"{folder}Table" if folder == entity else folder,
        "attr": field_name(table["name"]),
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
        "tables": [_table_info(orm, schema, design, settings, table) for table in schema["tables"]],
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


def optional_type(column: dict) -> str:
    """The type of a property that may be null."""
    return nullable(column["php"])


def stored_type(column: dict) -> str:
    """The type of a value that is stored: null only when the column takes null."""
    return nullable(column["php"]) if column["column"]["nullable"] else column["php"]


FOLDERS = {"entity": "Entities", "repository": "Repositories", "service": "Services", "dtos": "Dtos"}


def _module_namespace(module: str) -> str:
    """app.entities → App\\Entities: the namespace the entities are imported from when none are written."""
    return "\\".join(pascal_name(part) for part in module.split("."))


def namespace_of(context: dict, info: dict, kind: str) -> str:
    """The namespace of one kind of class of a table: App\\Repositories or App\\Tables\\OrderLines."""
    if kind == "entity" and not info["writesEntity"]:
        return _module_namespace(context["settings"]["entitiesModule"])
    if context["settings"]["architecture"] == "table":
        return f"{context['base']}\\Tables\\{info['folder']}"
    return f"{context['base']}\\{FOLDERS[kind]}"


def class_name(ns: str, name: str) -> str:
    """The full name of a class: App\\Entities\\Customer."""
    return f"{ns}\\{name}"


def path_of(ns: str, name: str) -> str:
    """The file of a class, by PSR-4: App\\Tables\\OrderLines → src/Tables/OrderLines/<name>.php."""
    parts = ns.split("\\")
    return "/".join(["src", *parts[1:], f"{name}.php"])


def errors_namespace(context: dict) -> str:
    return f"{context['base']}\\Errors"


def common_namespace(context: dict) -> str:
    return f"{context['base']}\\Common"


def error_class(context: dict, name: str) -> str:
    return class_name(errors_namespace(context), name)


def common_class(context: dict, name: str) -> str:
    return class_name(common_namespace(context), name)


def root_class(context: dict, name: str) -> str:
    return class_name(context["base"], name)


def _read_name(context: dict, neutral: str, must_exist: bool) -> str:
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return re.sub(r"^(get|find)(?=[A-Z])", verb, neutral, count=1)


def query_name(context: dict, query_design: dict) -> str:
    """findById: the PHP name of a repository query."""
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


def repository_type(context: dict, info: dict) -> str:
    """The type a repository is used through: its interface, or the database class when there are none."""
    return repository_interface(info) if context["settings"]["repositoryInterfaces"] else sql_repository_class(info)


def php_file(path: str, ns: str, uses: str, body: list) -> dict:
    """The file of a PHP class: the opening tag, strict types, the namespace, its uses and its body."""
    content = [
        "<?php",
        "",
        "declare(strict_types=1);",
        "",
        f"namespace {ns};",
        "",
        *([uses, ""] if uses else []),
        *body,
        "",
    ]
    return {"path": path, "content": "\n".join(line for line in content if isinstance(line, str))}


def ind(items: list, spaces: int = 4) -> list:
    """Indents the lines that apply; empty lines stay empty."""
    pad = " " * spaces
    return [(line if line == "" else pad + line) if isinstance(line, str) else line for line in items]
