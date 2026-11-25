"""What every file of a Rust project needs to know about each table, computed once: the names of its types, fields and
modules, its columns with their Rust types, its key, the decisions of the review and the queries and operations that
are on. Types are written with their full path (chrono::NaiveDate), so files import only traits and the crate's own
items. Mirrors web/src/core/generators/rust/context.ts.

A column info is {"column", "field", "variant", "key", "rs", "crate", "copy", "generated", "required"}; a table info
holds the keys of TableInfo; the context is {"schema", "design", "settings", "tables", "crate"}.
"""

import json
import re

from ...crud.types import find_policy, find_repository, find_service
from ...model.naming import to_snake_case
from .documents import nested_structs, value_type
from .rust import column_variant, snake_name, type_name

BLOCKING = (None, "no action", "restrict")


def rs_type(column_type: dict) -> tuple[str, str | None, bool]:
    """The Rust type of a database value, the crate it comes from, and whether it is Copy."""
    kind = column_type["kind"]
    if kind == "integer":
        return {16: "i16", 64: "i64"}.get(column_type["bits"], "i32"), None, True
    if kind == "decimal":
        return "rust_decimal::Decimal", "rust_decimal", True
    if kind == "float":
        return ("f32" if column_type["bits"] == 32 else "f64"), None, True
    if kind == "boolean":
        return "bool", None, True
    if kind == "date":
        return "chrono::NaiveDate", "chrono", True
    if kind == "time":
        return "chrono::NaiveTime", "chrono", True
    if kind == "datetime":
        if column_type.get("timezone"):
            return "chrono::DateTime<chrono::FixedOffset>", "chrono", True
        return "chrono::NaiveDateTime", "chrono", True
    if kind == "uuid":
        return "uuid::Uuid", "uuid", True
    if kind == "binary":
        return "Vec<u8>", None, False
    # JSON (and arrays, kept as JSON) as its text; enums as their value; unknown types as their text
    return "String", None, False


def _blocking_links(schema: dict, table: dict) -> list[dict]:
    return [
        {"table": other["name"], "columns": key["columns"], "references": key["references"]["columns"]}
        for other in schema["tables"]
        for key in other["foreignKeys"]
        if key["references"]["table"] == table["name"] and key.get("onDelete") in BLOCKING
    ]


def _included(items: list[dict]) -> list[dict]:
    return [item for item in items if item["include"]["value"]]


def _column_info(column: dict, types: tuple[str, str | None, bool], own: bool) -> dict:
    generated = column.get("generated") is not None and column.get("generated") != "onUpdateNow"
    # MongoDB's `_id` is the `id` of the entity, unless the documents have one of their own
    field = "document_id" if own else snake_name(column["name"])
    rs, crate, copy = types
    return {
        "column": column,
        "field": field,
        "variant": column_variant(field),
        "key": re.sub(r"^r#", "", field),
        "rs": rs,
        "crate": crate,
        "copy": copy,
        "generated": generated,
        "required": not column["nullable"] and "default" not in column and not generated,
    }


def _table_info(orm: dict, schema: dict, design: dict, settings: dict, table: dict) -> dict:
    policy = find_policy(design, table["name"])
    repository = find_repository(design, table["name"])
    service = find_service(design, table["name"]) if settings["services"] else None
    entity = type_name(repository["entity"])
    delete_mode = policy["delete"]["value"]
    concurrency = policy["concurrency"]["value"]
    own_entities = (
        not orm.get("documents") and not repository["entityMissing"] and schema["source"]["format"] == settings["orm"]
    )
    writes_entity = settings["entities"] == "all" or (settings["entities"] == "missing" and not own_entities)
    module = snake_name(entity)
    attr = snake_name(table["name"])
    documents = bool(orm.get("documents"))
    entity_module = _entity_module(settings, module, attr, writes_entity)
    nested = nested_structs(table["columns"], entity, entity_module) if documents else {}
    own_id = documents and any(column["name"] == "id" for column in table["columns"])

    def types_of(column: dict) -> tuple[str, str | None, bool]:
        if not documents:
            return rs_type(column["type"])
        struct = nested.get(column["name"])
        return value_type(column["type"], struct["path"] if struct else None)

    columns = [
        _column_info(column, types_of(column), own_id and column["name"] == "_id") for column in table["columns"]
    ]

    def by_name(name: str) -> dict:
        return next(info for info in columns if info["column"]["name"] == name)

    # A table without a primary key is read only; its rows are told apart by all their columns
    key_names = (
        table["primaryKey"] if table["primaryKey"] is not None else [column["name"] for column in table["columns"]]
    )
    children = policy["children"]
    return {
        "table": table,
        "name": table["name"],
        "entity": entity,
        "module": module,
        "attr": attr,
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
        "nested": nested,
    }


def create_context(orm: dict, schema: dict, design: dict, settings: dict) -> dict:
    return {
        "orm": orm,
        "schema": schema,
        "design": design,
        "settings": settings,
        "tables": [_table_info(orm, schema, design, settings, table) for table in schema["tables"]],
        "crate": settings["name"].replace("-", "_"),
    }


def _entity_module(settings: dict, module: str, attr: str, written: bool) -> str:
    """The module of an entity, before its table is known."""
    if not written:
        return f"{'::'.join(settings['entitiesModule'].split('.'))}::{module}"
    if settings["architecture"] == "table":
        return f"crate::{attr}::entity"
    return f"crate::{LAYERS['entity']}::{module}"


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
    """The type of a value that is stored: Option only when the column takes null."""
    return f"Option<{column['rs']}>" if column["column"]["nullable"] else column["rs"]


def option_of(expression: str, column: dict) -> str:
    """The value of a field that may be empty (an Option), copied."""
    return expression if column["copy"] else f"{expression}.clone()"


def stored(expression: str, column: dict) -> str:
    """The value of an entity's field known to be set: entity.id.expect(…) (copied), or as it is when it takes null."""
    if column["column"]["nullable"]:
        return option_of(expression, column)
    message = json.dumps(f"{column['key']} is set", ensure_ascii=False)
    return f"{option_of(expression, column)}.expect({message})"


# Modules and names

LAYERS = {
    "entity": "entities",
    "table": "entities",
    "repository": "repositories",
    "service": "services",
    "dtos": "dtos",
}


def module_of(context: dict, info: dict, kind: str) -> str:
    """The module of one kind of file of a table: crate::repositories::order_line or crate::order_lines::repository."""
    if kind in ("entity", "table") and not info["writesEntity"]:
        base = "::".join(context["settings"]["entitiesModule"].split("."))
        return f"{base}::{info['module'] + '_table' if kind == 'table' else info['module']}"
    if context["settings"]["architecture"] == "table":
        return f"crate::{info['attr']}::{kind}"
    return f"crate::{LAYERS[kind]}::{info['module'] + '_table' if kind == 'table' else info['module']}"


def path_in(module: str, name: str) -> str:
    """crate::errors::DomainError"""
    return f"{module}::{name}"


def file_of(module: str) -> str:
    """The file of a module: crate::repositories::order_line → src/repositories/order_line.rs."""
    parts = [re.sub(r"^r#", "", part) for part in module.split("::")[1:]]
    return f"src/{'/'.join(parts)}.rs"


def _read_name(context: dict, neutral: str, must_exist: bool) -> str:
    verbs = context["settings"]["verbs"]
    verb = ("get" if must_exist else "find") if verbs == "getFind" else verbs
    return re.sub(r"^(get|find)(?=[A-Z])", verb, neutral, count=1)


def query_name(context: dict, query_design: dict) -> str:
    """find_by_id: the Rust name of a repository query."""
    name = (
        _read_name(context, query_design["name"], False)
        if query_design["kind"] in ("getByKey", "findByUnique")
        else query_design["name"]
    )
    return snake_name(to_snake_case(name))


def operation_name(context: dict, operation: dict) -> str:
    if operation["kind"] == "get":
        name = _read_name(context, operation["name"], True)
    elif operation["kind"] == "find":
        name = _read_name(context, operation["name"], False)
    else:
        name = operation["name"]
    return snake_name(to_snake_case(name))


def repository_trait(info: dict) -> str:
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


def key_type(info: dict) -> str:
    """The type of a table's key: i64, or a tuple when it has several columns."""
    if len(info["key"]) == 1:
        return info["key"][0]["rs"]
    return f"({', '.join(column['rs'] for column in info['key'])})"


def rs_file(path: str, uses: str, body: list, doc: list[str] | None = None) -> dict:
    """The file of a Rust module: its use lines and body (None and False lines are left out)."""
    doc_lines = ["//!" if line == "" else f"//! {line}" for line in (doc or [])]
    content = [*doc_lines, *([""] if doc_lines else []), *([uses, ""] if uses != "" else []), *body, ""]
    return {"path": path, "content": "\n".join(line for line in content if isinstance(line, str))}


def ind(items: list[str], spaces: int = 4) -> list[str]:
    """Indents the lines that apply."""
    return ["" if line == "" else " " * spaces + line for line in items]
