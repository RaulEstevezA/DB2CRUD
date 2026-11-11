"""Proposes the CRUD design of a physical schema (docs/design.md, section 3): the role of each table and the decisions
the schema cannot settle, the queries of each repository and the operations of each service. Every proposal carries
its confidence and its reasons. Mirrors web/src/core/crud/propose.ts.

Given the previous design, the proposal keeps every choice the user made where it still applies.
"""

from ..decisions.decision import decision, reason, same_value
from ..model.naming import pluralize, singularize, split_words, to_pascal_case
from ..schema.types import find_table, is_unique_key
from .types import find_policy, find_repository, find_service

SOFT_DELETE_COLUMNS = ("deleted_at", "is_deleted", "deleted")
VERSION_COLUMNS = ("version", "row_version", "lock_version")
# Words that name a secret: such columns are never returned unless the user says so
SECRET_WORDS = ("password", "passwd", "secret", "token")

# Actions that leave the children in place, so deleting the parent fails while they exist
BLOCKING_ACTIONS = (None, "no action", "restrict")


def _snake(name: str) -> str:
    return "_".join(split_words(name)).lower()


def entity_name(table: dict) -> str:
    """order_lines → OrderLine; the input's class name when it has one."""
    if table.get("entity"):
        return table["entity"]
    words = split_words(table["name"])
    if not words:
        return to_pascal_case(table["name"])
    return to_pascal_case(" ".join([*words[:-1], singularize(words[-1])]))


def _plural_name(entity: str) -> str:
    words = split_words(entity)
    return to_pascal_case(" ".join([*words[:-1], pluralize(words[-1])]))


def _by_columns(columns: list[str]) -> str:
    return "And".join(to_pascal_case(column) for column in columns)


def _keep(previous: dict | None, proposed: dict) -> dict:
    """A new proposal that keeps the user's earlier choice when it is still one of the options."""
    if not previous or not previous.get("manual"):
        return proposed
    if not any(same_value(option, previous["value"]) for option in proposed["options"]):
        return proposed
    return {**proposed, "value": previous["value"], "status": "active", "manual": True}


def _include(confidence: str, reasons: list[dict]) -> dict:
    return decision(True, confidence, reasons, [True, False])


# Table decisions


def _join_parents(table: dict) -> list[dict] | None:
    """A join table: the whole primary key is made of two foreign keys, and there is nothing else."""
    key = table["primaryKey"]
    if not key or len(key) < 2 or len(table["columns"]) != len(key) or len(table["foreignKeys"]) != 2:
        return None
    covered = [column for foreign_key in table["foreignKeys"] for column in foreign_key["columns"]]
    return table["foreignKeys"] if len(covered) == len(key) and all(column in covered for column in key) else None


def _propose_role(table: dict) -> dict:
    if not table["primaryKey"]:
        return decision("readOnly", "review", [reason("noPrimaryKey")], ["readOnly"])
    parents = _join_parents(table)
    if parents:
        tables = ", ".join(key["references"]["table"] for key in parents)
        return decision("join", "probable", [reason("joinTable", {"tables": tables})], ["join", "entity"])
    return decision("entity", "exact", [reason("tableWithKey")], ["entity", "readOnly"])


def _propose_delete(table: dict) -> dict:
    column = next((item for item in table["columns"] if _snake(item["name"]) in SOFT_DELETE_COLUMNS), None)
    if not column:
        return decision({"mode": "hard"}, "exact", [reason("noSoftDeleteColumn")], [{"mode": "hard"}])
    soft = {"mode": "soft", "column": column["name"]}
    return decision(soft, "review", [reason("softDeleteColumn", {"column": column["name"]})], [soft, {"mode": "hard"}])


def _propose_concurrency(table: dict) -> dict:
    column = next(
        (
            item
            for item in table["columns"]
            if _snake(item["name"]) in VERSION_COLUMNS and item["type"]["kind"] == "integer"
        ),
        None,
    )
    if not column:
        return decision({"mode": "none"}, "exact", [reason("noVersionColumn")], [{"mode": "none"}])
    version = {"mode": "version", "column": column["name"]}
    return decision(
        version, "probable", [reason("versionColumn", {"column": column["name"]})], [version, {"mode": "none"}]
    )


def _blocking_children(schema: dict, table: dict) -> list[str]:
    """Tables with a foreign key to this one that declares no action on delete."""
    children: list[str] = []
    for other in schema["tables"]:
        for key in other["foreignKeys"]:
            references = key["references"]
            if (
                references["table"] == table["name"]
                and references.get("schema", table.get("schema")) == table.get("schema")
                and key.get("onDelete") in BLOCKING_ACTIONS
                and other["name"] not in children
            ):
                children.append(other["name"])
    return children


def _propose_children(schema: dict, table: dict) -> dict | None:
    children = _blocking_children(schema, table)
    if not children:
        return None
    return decision(
        "block", "review", [reason("childrenWithoutAction", {"tables": ", ".join(children)})], ["block", "deleteFirst"]
    )


def _is_secret(column: dict) -> bool:
    words = [word.lower() for word in split_words(column["name"])]
    return any(word in SECRET_WORDS for word in words) or "api key" in " ".join(words)


def _propose_hidden(table: dict) -> dict:
    secrets = [column["name"] for column in table["columns"] if _is_secret(column)]
    if not secrets:
        return decision([], "exact", [reason("noSecrets")], [[]])
    return decision(secrets, "review", [reason("secretNamed", {"columns": ", ".join(secrets)})], [secrets, []])


def _propose_policy(schema: dict, table: dict, previous: dict | None) -> dict:
    children = _propose_children(schema, table)
    return {
        "table": table["name"],
        "role": _keep(previous and previous["role"], _propose_role(table)),
        "delete": _keep(previous and previous["delete"], _propose_delete(table)),
        "concurrency": _keep(previous and previous["concurrency"], _propose_concurrency(table)),
        "children": _keep(previous and previous["children"], children) if children else None,
        "hidden": _keep(previous and previous["hidden"], _propose_hidden(table)),
    }


# Repositories


def _query_indexes(table: dict) -> list[dict]:
    """Indexes that add a query of their own: not the primary key, a unique constraint or a foreign key again."""
    return [
        index
        for index in table["indexes"]
        if not is_unique_key(table, index["columns"])
        and not any(key["columns"] == index["columns"] for key in table["foreignKeys"])
    ]


def _propose_queries(table: dict, role: str, previous: dict | None) -> list[dict]:
    queries: list[dict] = []

    def add(query: dict) -> None:
        before = next((item for item in previous["queries"] if item["id"] == query["id"]), None) if previous else None
        queries.append({**query, "include": _keep(before and before["include"], query["include"])})

    def entry(query_id, kind, name, columns, returns, proposal) -> dict:
        return {"id": query_id, "kind": kind, "name": name, "columns": columns, "returns": returns, "include": proposal}

    key = table["primaryKey"]
    if key and role != "readOnly":
        add(
            entry(
                "getByKey",
                "getByKey",
                f"getBy{_by_columns(key)}",
                key,
                "optional",
                _include("exact", [reason("primaryKey", {"columns": ", ".join(key)})]),
            )
        )
    add(entry("list", "list", "list", [], "many", _include("exact", [])))
    for unique in table["uniques"]:
        columns = unique["columns"]
        add(
            entry(
                f"findByUnique:{','.join(columns)}",
                "findByUnique",
                f"findBy{_by_columns(columns)}",
                columns,
                "optional",
                _include("exact", [reason("uniqueConstraint", {"columns": ", ".join(columns)})]),
            )
        )
    for foreign_key in table["foreignKeys"]:
        columns = foreign_key["columns"]
        add(
            entry(
                f"listByParent:{','.join(columns)}",
                "listByParent",
                f"listBy{_by_columns(columns)}",
                columns,
                "many",
                _include("exact", [reason("foreignKey", {"table": foreign_key["references"]["table"]})]),
            )
        )
    for index in _query_indexes(table):
        columns = index["columns"]
        add(
            entry(
                f"findAllBy:{','.join(columns)}",
                "findAllBy",
                f"findAllBy{_by_columns(columns)}",
                columns,
                "many",
                decision(True, "review", [reason("indexOnly", {"columns": ", ".join(columns)})], [True, False]),
            )
        )
    if role != "readOnly":
        writes = [reason("primaryKey", {"columns": ", ".join(key or [])})]
        add(entry("insert", "insert", "insert", [], "one", _include("exact", writes)))
        if role == "entity":
            add(entry("update", "update", "update", [], "one", _include("exact", writes)))
        add(entry("delete", "delete", "delete", key or [], "none", _include("exact", writes)))
    return queries


# Services


def _propose_operations(schema: dict, table: dict, policy: dict, previous: dict | None) -> list[dict]:
    role = policy["role"]["value"]
    entity = entity_name(table)
    plural = _plural_name(entity)
    has_uniques = bool(table["uniques"])
    has_parents = bool(table["foreignKeys"])
    versioned = policy["concurrency"]["value"]["mode"] == "version"
    blocked = bool(policy["children"]) and policy["children"]["value"] == "block"
    operations: list[dict] = []

    def add(operation_id, kind, name, checks, errors, extra=None, proposal=None) -> None:
        before = (
            next((item for item in previous["operations"] if item["id"] == operation_id), None) if previous else None
        )
        operation = {"id": operation_id, "kind": kind, "name": name, "columns": []}
        operation.update(extra or {})
        operation["include"] = _keep(before and before["include"], proposal or _include("exact", []))
        operation["checks"] = [check for check in checks if check]
        operation["errors"] = [error for error in errors if error]
        operations.append(operation)

    if role == "entity":
        add(
            "create",
            "create",
            f"create{entity}",
            ["validate", has_uniques and "unique", has_parents and "parentExists"],
            ["ValidationFailed", has_uniques and "Conflict"],
        )
        add("get", "get", f"get{entity}", [], ["NotFound"])
    add("list", "list", f"list{plural}", [], [])
    if role == "entity":
        add(
            "update",
            "update",
            f"update{entity}",
            ["validate", has_uniques and "unique", has_parents and "parentExists", versioned and "version"],
            ["NotFound", "ValidationFailed", (has_uniques or versioned) and "Conflict"],
        )
        add(
            "delete",
            "delete",
            f"delete{entity}",
            [versioned and "version", blocked and "children"],
            ["NotFound", (versioned or blocked) and "Conflict"],
        )
    for unique in table["uniques"]:
        columns = unique["columns"]
        add(f"find:{','.join(columns)}", "find", f"find{entity}By{_by_columns(columns)}", [], [], {"columns": columns})
    for foreign_key in table["foreignKeys"]:
        columns = foreign_key["columns"]
        add(
            f"listByParent:{','.join(columns)}",
            "listByParent",
            f"list{plural}By{_by_columns(columns)}",
            [],
            [],
            {"columns": columns},
        )

    # Links through the join tables that point to this table, when the user keeps them as join tables
    if role == "entity":
        for other in schema["tables"]:
            parents = _join_parents(other)
            if not parents:
                continue
            own = next((key for key in parents if key["references"]["table"] == table["name"]), None)
            far = next((key for key in parents if key is not own), None)
            if not own or not far:
                continue
            far_table = find_table(schema, far["references"]["table"], far["references"].get("schema"))
            if not far_table:
                continue
            far_entity = entity_name(far_table)
            tables = ", ".join(key["references"]["table"] for key in parents)
            reasons = [reason("joinTable", {"tables": tables})]
            through = {"through": other["name"]}
            add(
                f"link:{other['name']}",
                "link",
                f"add{far_entity}",
                ["parentExists"],
                ["NotFound", "Conflict"],
                through,
                _include("exact", reasons),
            )
            add(
                f"unlink:{other['name']}",
                "unlink",
                f"remove{far_entity}",
                [],
                ["NotFound"],
                through,
                _include("exact", reasons),
            )
    return operations


def propose_crud(schema: dict, previous: dict | None = None) -> dict:
    """The CRUD design of the schema, keeping the user's earlier choices from `previous`."""
    policies = [
        _propose_policy(schema, table, find_policy(previous, table["name"]) if previous else None)
        for table in schema["tables"]
    ]
    # A join table only stays one while its role says so: the links of the parents depend on it
    joins = {policy["table"] for policy in policies if policy["role"]["value"] == "join"}
    linkable = {
        **schema,
        "tables": [other for other in schema["tables"] if not _join_parents(other) or other["name"] in joins],
    }

    repositories: list[dict] = []
    services: list[dict] = []
    for table, policy in zip(schema["tables"], policies, strict=True):
        role = policy["role"]["value"]
        repositories.append(
            {
                "table": table["name"],
                "entity": entity_name(table),
                "entityMissing": not table.get("entity"),
                "queries": _propose_queries(
                    table, role, find_repository(previous, table["name"]) if previous else None
                ),
            }
        )
        if role == "join":
            continue
        services.append(
            {
                "table": table["name"],
                "name": f"{entity_name(table)}Service",
                "operations": _propose_operations(
                    linkable, table, policy, find_service(previous, table["name"]) if previous else None
                ),
            }
        )
    return {"policies": policies, "repositories": repositories, "services": services}
