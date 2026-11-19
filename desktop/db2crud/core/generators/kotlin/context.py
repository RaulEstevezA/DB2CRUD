"""What every file of a Kotlin project needs to know about each table, computed once: the names of its classes,
properties and packages, its columns with their Kotlin types, its key, the decisions of the review and the queries and
operations that are on. Mirrors web/src/core/generators/kotlin/context.ts.

A column info is {"column", "prop", "key", "kt", "ktImport", "generated", "required"}; a table info holds the keys of
TableInfo; the context is {"schema", "design", "settings", "tables", "base"}.
"""

import re

from ...crud.types import find_policy, find_repository, find_service
from ...model.naming import to_camel_case
from .kotlin import member_name, type_name

BLOCKING = (None, "no action", "restrict")


def kt_type(column_type: dict, database: str) -> tuple[str, str | None]:
    """The Kotlin type of a database value, and what to import for it. Exposed has no timestamp with a time zone on
    MariaDB: there such a value is an Instant, the point in time it stands for."""
    kind = column_type["kind"]
    if kind == "integer":
        return {16: "Short", 64: "Long"}.get(column_type["bits"], "Int"), None
    if kind == "decimal":
        return "BigDecimal", "java.math.BigDecimal"
    if kind == "float":
        return ("Float" if column_type["bits"] == 32 else "Double"), None
    if kind == "boolean":
        return "Boolean", None
    if kind == "date":
        return "LocalDate", "java.time.LocalDate"
    if kind == "time":
        return "LocalTime", "java.time.LocalTime"
    if kind == "datetime":
        if column_type.get("timezone") and database == "mariadb":
            return "Instant", "java.time.Instant"
        if column_type.get("timezone"):
            return "OffsetDateTime", "java.time.OffsetDateTime"
        return "LocalDateTime", "java.time.LocalDateTime"
    if kind == "uuid":
        return "UUID", "java.util.UUID"
    if kind == "binary":
        return "ByteArray", None
    # JSON (and arrays, kept as JSON) as its text; enums as their value; unknown types as their text
    return "String", None


def _blocking_links(schema: dict, table: dict) -> list[dict]:
    return [
        {"table": other["name"], "columns": key["columns"], "references": key["references"]["columns"]}
        for other in schema["tables"]
        for key in other["foreignKeys"]
        if key["references"]["table"] == table["name"] and key.get("onDelete") in BLOCKING
    ]


def _included(items: list[dict]) -> list[dict]:
    return [item for item in items if item["include"]["value"]]


def _column_info(column: dict, database: str) -> dict:
    generated = column.get("generated") is not None and column.get("generated") != "onUpdateNow"
    kt, kt_import = kt_type(column["type"], database)
    return {
        "column": column,
        "prop": member_name(column["name"]),
        "key": to_camel_case(column["name"]) or "value",
        "kt": kt,
        "ktImport": kt_import,
        "generated": generated,
        "required": not column["nullable"] and "default" not in column and not generated,
    }


def _table_info(schema: dict, design: dict, settings: dict, table: dict) -> dict:
    policy = find_policy(design, table["name"])
    repository = find_repository(design, table["name"])
    service = find_service(design, table["name"]) if settings["services"] else None
    entity = type_name(repository["entity"])
    columns = [_column_info(column, settings["database"]) for column in table["columns"]]

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
        "tableObject": f"{entity}Table",
        "pkg": re.sub(r"[^a-z0-9]", "", table["name"].lower()) or "table",
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
        "base": "app",
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


def optional_type(column: dict) -> str:
    """The type of a property that may be null."""
    return f"{column['kt']}?"


def stored_type(column: dict) -> str:
    """The type of a value that is stored: ? only when the column takes null."""
    return f"{column['kt']}?" if column["column"]["nullable"] else column["kt"]


def stored(expression: str, column: dict) -> str:
    """The value of a property known to be set: entity.email!!, or as it is when the column takes null."""
    return expression if column["column"]["nullable"] else f"{expression}!!"


# Packages and names

FOLDERS = {"entity": "entities", "repository": "repositories", "service": "services", "dtos": "dtos"}


def package_of(context: dict, info: dict, kind: str) -> str:
    """The package of one kind of class of a table: app.repositories or app.orderlines."""
    if kind == "entity" and not info["writesEntity"]:
        return context["settings"]["entitiesModule"]
    if context["settings"]["architecture"] == "table":
        return f"{context['base']}.{info['pkg']}"
    return f"{context['base']}.{FOLDERS[kind]}"


def qualified(pkg: str, name: str) -> str:
    return f"{pkg}.{name}"


def path_of(pkg: str, name: str, test: bool = False) -> str:
    """The file of a class: app.orderlines → src/main/kotlin/app/orderlines/<name>.kt."""
    return "/".join([f"src/{'test' if test else 'main'}/kotlin", *pkg.split("."), f"{name}.kt"])


def errors_package(context: dict) -> str:
    return f"{context['base']}.errors"


def common_package(context: dict) -> str:
    return f"{context['base']}.common"


def _read_name(context: dict, neutral: str, must_exist: bool) -> str:
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return re.sub(r"^(get|find)(?=[A-Z])", verb, neutral, count=1)


def query_name(context: dict, query_design: dict) -> str:
    """findById: the Kotlin name of a repository query."""
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


def kt_file(path: str, pkg: str, imports: str, body: list) -> dict:
    """The file of a Kotlin class: its package, imports and body (None and False lines are left out)."""
    content = [f"package {pkg}", "", *([imports, ""] if imports != "" else []), *body, ""]
    return {"path": path, "content": "\n".join(line for line in content if isinstance(line, str))}


def ind(items: list, spaces: int = 4) -> list:
    """Indents the lines that apply."""
    return [("" if line == "" else " " * spaces + line) if isinstance(line, str) else line for line in items]
